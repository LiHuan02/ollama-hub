
'use strict';
/* ================= 运行环境与后端适配 =================
 * 本页面同时用于两个宿主：
 *   - 本地 Node 服务 (http://127.0.0.1:11435)   → 走同源 HTTP 接口
 *   - 浏览器扩展页面 (chrome-extension://...)   → 走 background service worker 消息
 */
const IS_EXT = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id
  && location.protocol.startsWith('chrome-extension');

const NodeBackend = {
  async status(){
    const r = await fetch('/api/status'); return r.json();
  },
  async hardware(){
    try{
      const r = await fetch('/api/hardware'); const j = await r.json();
      return (j && j.ramGB) ? { ram: j.ramGB, vram: j.maxSingleVramGB || j.vramGB || 0, gpus: j.gpus || [], detectedAt: j.detectedAt } : null;
    }
    catch{ return null; }
  },
  async search(q, sort, caps, filters={}){
    const params = new URLSearchParams({ q, sort, source: filters.source || 'all', updated: filters.updated || '', minPulls: String(filters.minPulls || 0) });
    if (caps.length) params.set('caps', caps.join(','));
    const r = await fetch('/hub/search?' + params);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j;
  },
  async model(name){
    const r = await fetch('/hub/model/' + encodeURIComponent(name));
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j;
  },
  async ollama(path, method='GET', body){
    const r = await fetch('/ollama'+path, {
      method,
      headers: body ? {'Content-Type':'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = {}; try{ j = await r.json(); }catch{}
    if(!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
  chat(payload, {onLine, onEnd}){
    const ctrl = new AbortController();
    (async()=>{try{
      const res=await fetch('/ollama/api/chat?stream=1',{method:'POST',signal:ctrl.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,stream:true})});
      if(!res.ok){let j={};try{j=await res.json()}catch{}throw new Error(j.error||`HTTP ${res.status}`)}
      const reader=res.body.getReader(),dec=new TextDecoder();let buf='';
      while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;while((i=buf.indexOf('\n'))>=0){const raw=buf.slice(0,i).trim();buf=buf.slice(i+1);if(raw){const ev=JSON.parse(raw);if(ev.error)throw new Error(ev.error);onLine(ev)}}}
      onEnd(null);
    }catch(e){onEnd(e.name==='AbortError'?{cancelled:true}:e)}})();
    return {cancel(){ctrl.abort()}};
  },
  pull(model, {onLine, onEnd}){
    const ctrl = new AbortController();
    (async () => {
      try{
        const res = await fetch('/ollama/api/pull?stream=1', {
          method:'POST', signal: ctrl.signal,
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({model, name:model, stream:true}),
        });
        if(!res.ok){
          let msg = `HTTP ${res.status}`;
          try{ msg = (await res.json()).error || msg; }catch{}
          throw new Error(msg);
        }
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf='';
        while(true){
          const {done, value} = await reader.read();
          if(done) break;
          buf += dec.decode(value, {stream:true});
          let i;
          while((i = buf.indexOf('\n')) >= 0){
            const line = buf.slice(0, i).trim(); buf = buf.slice(i+1);
            if(line){ let ev; try{ ev = JSON.parse(line); }catch{ continue; } onLine(ev); if(ev.error) throw new Error(ev.error); }
          }
        }
        onEnd(null);
      }catch(e){ onEnd(e.name==='AbortError' ? { cancelled:true } : e); }
    })();
    return { cancel(){ ctrl.abort(); } };
  },
};

const ExtBackend = {
  async status(){ return chrome.runtime.sendMessage({kind:'status'}); },
  async hardware(){ return null; /* 扩展环境读不到硬件，使用帮助页里的手动设置 */ },
  async search(q, sort, caps, filters={}){
    const j = await chrome.runtime.sendMessage({kind:'search', q, sort, caps, filters});
    if (j && j.error) throw new Error(j.error);
    return j;
  },
  async model(name){
    const j = await chrome.runtime.sendMessage({kind:'model', name});
    if (j && j.error) throw new Error(j.error);
    return j;
  },
  async ollama(path, _method='GET', body){
    const op = path === '/api/generate' ? 'unload' : path.replace(/^\/api\//, '');
    const r = await chrome.runtime.sendMessage({kind:'ollama', op, body});
    if (r && (r.__error || r.error)) throw new Error(r.error);
    return r;
  },
  chat(payload,{onLine,onEnd}){
    const port=chrome.runtime.connect({name:'chat'});let terminal=false;
    port.onMessage.addListener(m=>{if(m.type==='chunk')onLine(m.line);else if(m.type==='end'){terminal=true;onEnd(m.cancelled?{cancelled:true}:(m.error?new Error(m.error):null))}});
    port.onDisconnect.addListener(()=>{if(!terminal)onEnd(new Error(chrome.runtime.lastError?.message||'聊天连接已断开'))});
    port.postMessage({payload});return {cancel(){try{port.postMessage({type:'cancel'})}catch{}}};
  },
  pull(model, {onLine, onEnd}){
    const port = chrome.runtime.connect({name:'pull'});
    let terminal = false;
    port.onMessage.addListener(m => {
      if(m.type==='line') onLine(m.line);
      else if(m.type==='end'){ terminal=true; onEnd(m.cancelled ? {cancelled:true} : (m.error ? new Error(m.error) : null)); }
    });
    port.onDisconnect.addListener(() => { if(!terminal) onEnd(new Error(chrome.runtime.lastError?.message || '下载连接已断开')); });
    port.postMessage({model});
    return { cancel(){ try{ port.postMessage({type:'cancel'}); }catch{} } };
  },
};

const B = IS_EXT ? ExtBackend : NodeBackend;

/* ================= 基础 ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const state = { ok:false, models:[], running:[], lastQuery:'', libCache:new Map(), hw:null, hwAuto:null, caps:[], filters:{source:'all', updated:'', minPulls:0, size:'', pressure:''} };
const pulls = new Map();

function fmtSize(n){
  if(!n && n!==0) return '';
  const u=['B','KB','MB','GB','TB']; let i=0;
  while(n>=1024 && i<u.length-1){n/=1024;i++}
  return (i===0?n:n.toFixed(1))+' '+u[i];
}
function fmtDate(iso){ try{ return new Date(iso).toLocaleString('zh-CN',{hour12:false}); }catch{ return iso||'' } }
function toast(msg, type=''){
  const t=document.createElement('div'); t.className='toast '+type; t.textContent=msg;
  $('#toasts').appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transition='.3s';setTimeout(()=>t.remove(),300)}, 2600);
}
async function copyText(s){
  try{ await navigator.clipboard.writeText(s); toast('已复制：'+s, 'ok'); }
  catch{ toast('复制失败，请手动复制：'+s, 'err'); }
}
function normRef(v){ return String(v||'').trim().toLowerCase(); }
function parentRef(v){ const s=normRef(v), slash=s.lastIndexOf('/'), colon=s.lastIndexOf(':'); return colon>slash?s.slice(0,colon):s; }
function refsOf(m){ return new Set([m?.name,m?.model].map(normRef).filter(Boolean)); }
function localVariants(parent){ return state.models.filter(m=>[...refsOf(m)].some(r=>parentRef(r)===parentRef(parent))); }
function tagInstallStatus(tag){
  const target=normRef(tag.model), parent=parentRef(target);
  const exact=state.models.find(m=>refsOf(m).has(target));
  if(exact) return {kind:'exact',local:exact};
  const prefix=normRef(tag.digest);
  const equivalent=prefix.length>=12&&state.models.find(m=>[...refsOf(m)].some(r=>parentRef(r)===parent)&&normRef(m.digest).startsWith(prefix));
  return equivalent?{kind:'equivalent',local:equivalent}:{kind:'none'};
}

/* ================= 运行压力估算 ================= */
function parseSizeGB(s){
  const m = String(s||'').match(/([\d.]+)\s*(TB|GB|MB)/i);
  if(!m) return null;
  let v = parseFloat(m[1]);
  if(/mb/i.test(m[2])) v /= 1024;
  else if(/tb/i.test(m[2])) v *= 1024;
  return v;
}
function calcPressure(sizeStr){
  const hw = state.hw;
  const size = parseSizeGB(sizeStr);
  if(!hw || !hw.ram || !size) return null;
  const vram = +hw.vram || 0, ram = +hw.ram;
  const runtime = size * 1.35 + 0.8;
  const usable = vram > 0 ? vram + ram * 0.45 : ram * 0.6;
  if (vram > 0 && runtime <= vram * 0.95) return { level:0, label:'轻松', est:runtime.toFixed(1) };
  if (runtime <= usable)                  return { level:1, label:'勉强', est:runtime.toFixed(1) };
  return { level:2, label:'基本不可运行', est:runtime.toFixed(1) };
}
function pressureHTML(sizeStr){
  const pr = calcPressure(sizeStr);
  if(!pr) return '';
  return `<span class="pr l${pr.level}" title="估算运行占用约 ${pr.est}GB（含上下文开销）">${pr.label}</span>`;
}
function pressureDot(sizeStr){
  const pr = calcPressure(sizeStr);
  if(!pr) return '';
  const c = ['var(--ok)','var(--warn)','var(--danger)'][pr.level];
  return `<span class="pdot" style="background:${c}" title="本机压力：${pr.label}（估算占用 ${pr.est}GB）"></span>`;
}
function estimatedVariantGB(item){
  const nums = (item.variants || []).map(v=>Number(String(v).match(/([\d.]+)b/i)?.[1])).filter(Number.isFinite);
  if(!nums.length) return null;
  return Math.min(...nums) * 0.62; // Q4 GGUF 的保守近似，真实大小以展开版本为准
}
function localAdvancedFilter(items){
  const { size, pressure } = state.filters;
  if(!size && pressure==='') return items;
  return items.filter(item=>{
    const gb = estimatedVariantGB(item);
    if(size==='small' && !(gb!=null && gb<=4)) return false;
    if(size==='medium' && !(gb!=null && gb>4 && gb<10)) return false;
    if(size==='large' && !(gb!=null && gb>=10)) return false;
    if(pressure!==''){
      if(gb==null) return false;
      const p=calcPressure(gb+'GB');
      if(!p || p.level!==Number(pressure)) return false;
    }
    return true;
  });
}

/* ================= 硬件信息 ================= */
function loadHardware(){
  let ov = null;
  try{ ov = JSON.parse(localStorage.getItem('oh_hw') || 'null'); }catch{}
  state.hw = (ov && ov.ram) ? ov : state.hwAuto;
  renderHwUI();
}
function renderHwUI(){
  const pill = $('#hwPill');
  if(state.hw && state.hw.ram){
    pill.classList.remove('hidden');
    pill.textContent = `💻 RAM ${state.hw.ram}GB` + (state.hw.vram ? ` · VRAM ${state.hw.vram}GB` : ' · 无独显');
  } else pill.classList.add('hidden');
  // 帮助页控件
  if(state.hw){ $('#hwRam').value = state.hw.ram; $('#hwVram').value = state.hw.vram || 0; }
  const auto = state.hwAuto;
  $('#hwNote').textContent = auto && auto.ram
    ? `自动检测：内存 ${auto.ram}GB，显存 ${auto.vram ? auto.vram + 'GB（' + (auto.gpus||[]).join(' / ') + '）' : '未检测到独立显卡'}。检测结果不准（如双显存笔记本）可直接在上方填写覆盖。`
    : (IS_EXT ? '扩展环境无法自动读取硬件信息，请在上方手动填写内存/显存大小，用于估算各版本模型的运行压力。'
              : '暂未获取到硬件信息，可在上方手动填写。');
}

/* ================= 连接状态 ================= */
async function checkStatus(){
  try{
    const s = await B.status();
    const was = state.ok;
    state.ok = !!(s && s.ok);
    const pill = $('#conn');
    pill.className = 'pill ' + (state.ok ? 'on' : 'off');
    $('#connText').textContent = state.ok ? `已连接 · v${s.version}` : '未连接';
    $('#hostText').textContent = (s && s.upstream) || (IS_EXT ? 'http://127.0.0.1:11434' : '');
    $('#banner').classList.toggle('hidden', state.ok);
    if(state.ok && !was){ loadInstalled(); loadRunning(); }
  }catch{
    state.ok=false; $('#banner').classList.remove('hidden');
  }
}

/* ================= 已安装 ================= */
async function loadInstalled(){
  const box = $('#installedList');
  try{
    const j = await B.ollama('/api/tags');
    state.models = (j.models||[]).sort((a,b)=>(b.size||0)-(a.size||0));
    $('#cntInstalled').textContent = state.models.length || '';
    const total = state.models.reduce((s,m)=>s+(m.size||0),0);
    $('#installedSummary').textContent = state.models.length ? `${state.models.length} 个 · 共 ${fmtSize(total)}` : '';
    if(!state.models.length){
      box.innerHTML = `<div class="empty">还没有安装任何模型<br><br>
        <button class="btn primary" id="goLibrary">去模型市场逛逛 →</button></div>`;
      $('#goLibrary').addEventListener('click', () => switchTab('library'));
      return;
    }
    box.innerHTML = state.models.map(m=>{
      const d = m.details||{}, caps = m.capabilities||d.capabilities||[];
      const sizeGB = (m.size/2**30).toFixed(1)+'GB';
      const badges = [
        d.parameter_size && `<span class="badge b">${esc(d.parameter_size)}</span>`,
        d.quantization_level && `<span class="badge">${esc(d.quantization_level)}</span>`,
        d.family && `<span class="badge">${esc(d.family)}</span>`,
        ...caps.map(c=>`<span class="badge">${esc(c)}</span>`),
        pressureHTML(sizeGB),
      ].filter(Boolean).join('');
      return `<div class="row" data-name="${esc(m.name)}">
        <div class="row-main">
          <div class="m-name">${esc(m.name)}</div>
          <div class="badges">${badges}</div>
        </div>
        <div class="m-size">${fmtSize(m.size)}</div>
        <div class="m-date">${fmtDate(m.modified_at).split(' ')[0]}</div>
        <div class="row-actions">
          <button class="btn small ghost" data-act="detail">详情</button>
          <button class="btn small ghost" data-act="copy" title="复制 ollama run 命令">⧉</button>
          <button class="btn small danger" data-act="del">删除</button>
        </div>
      </div>`;
    }).join('');
  }catch(e){
    box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

$('#installedList').addEventListener('click', e=>{
  const btn = e.target.closest('[data-act]');
  if(!btn) return;
  const name = btn.closest('.row').dataset.name;
  const act = btn.dataset.act;
  if(act==='copy') return copyText(`ollama run ${name}`);
  if(act==='del') return confirmDelete(name);
  if(act==='detail') return showDetail(name);
});

function confirmDelete(name){
  openModal(`<h3>删除模型</h3>
    <p style="font-size:13.5px;color:var(--muted)">确定删除 <b style="font-family:var(--mono);color:var(--text)">${esc(name)}</b> 吗？
    该操作会永久移除本地模型文件，释放磁盘空间（可随时重新拉取）。</p>
    <div class="modal-actions">
      <button class="btn" data-close>取消</button>
      <button class="btn danger" id="btnDoDel">删除</button>
    </div>`);
  $('#btnDoDel').onclick = async ()=>{
    $('#btnDoDel').disabled = true;
    try{
      await B.ollama('/api/delete', 'DELETE', {model:name, name});
      toast(`已删除 ${name}`, 'ok');
      state.libCache.clear();
      closeModal(); loadInstalled();
    }catch(e){ toast('删除失败：'+e.message, 'err'); $('#btnDoDel').disabled=false; }
  };
}

async function showDetail(name){
  openModal(`<h3>模型详情</h3><div class="loading">加载中</div>`);
  try{
    const j = await B.ollama('/api/show', 'POST', {model:name, name});
    const d = j.details||{}; const caps = j.capabilities||d.capabilities||[];
    const kv = [
      ['模型名称', name],
      ['参数规模', d.parameter_size],
      ['量化等级', d.quantization_level],
      ['模型家族', d.families ? d.families.join(', ') : d.family],
      ['上下文长度', d.context_length ? d.context_length.toLocaleString() : ''],
      ['嵌入维度', d.embedding_length],
      ['能力', caps.join(', ')],
      ['格式', d.format],
    ].filter(([,v])=>v!==undefined && v!==null && v!=='');
    const local = state.models.find(m=>m.name===name);
    if(local){ kv.unshift(['占用空间', fmtSize(local.size)], ['更新时间', fmtDate(local.modified_at)]); }
    let html = `<h3 style="font-family:var(--mono)">${esc(name)}</h3>
      <table class="kv">${kv.map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
    for(const [title, val] of [['参数定义 Parameters', j.parameters], ['模板 Template', j.template], ['Modelfile', j.modelfile]]){
      if(val) html += `<details class="raw"><summary>${title}</summary><pre>${esc(val)}</pre></details>`;
    }
    html += `<div class="modal-actions"><button class="btn" data-close>关闭</button></div>`;
    $('#modalBox').innerHTML = html;
  }catch(e){
    $('#modalBox').innerHTML = `<h3>模型详情</h3><div class="empty">加载失败：${esc(e.message)}</div>
      <div class="modal-actions"><button class="btn" data-close>关闭</button></div>`;
  }
}

/* ================= 模型市场 ================= */
async function loadLibrary(q=''){
  const box = $('#libList');
  state.lastQuery = q;
  box.innerHTML = '<div class="loading">加载中</div>';
  try{
    const sort = $('#sort').value;
    const r = await B.search(q, sort, state.caps, state.filters);
    const items = localAdvancedFilter(r.items);
    if(!items.length){
      box.innerHTML = `<div class="empty">没有找到符合当前条件的模型</div>`;
      return;
    }
    box.innerHTML = items.map(renderCard).join('');
  }catch(e){
    box.innerHTML = `<div class="empty">加载模型库失败：${esc(e.message)}<br><br>仍可通过上方输入框直接拉取模型</div>`;
  }
}

function renderCard(it){
  const chips = [
    ...it.capabilities.map(c=>`<span class="badge">${esc(c)}</span>`),
    ...it.variants.map(v=>`<span class="badge b">${esc(v)}</span>`),
  ].join('');
  const meta = [
    it.pulls && `⬇ ${esc(it.pulls)}`, it.tagCount && `${esc(it.tagCount)} 个版本`, it.updated && `${esc(it.updated)}更新`,
  ].filter(Boolean).join(' · ');
  const installed = localVariants(it.name);
  const installLabel = installed.length ? `<span class="badge" style="color:var(--ok);border-color:#c9dcc0" title="${esc(installed.map(m=>m.name).join(', '))}">已安装 ${installed.length} 个版本</span>` : '';
  return `<div class="card" data-name="${esc(it.name)}">
    <div class="card-head">
      <div class="c-main">
        <div class="c-title">${esc(it.name)} ${chips} ${installLabel}</div>
        <div class="c-desc">${esc(it.description)}</div>
      </div>
      <div class="c-meta">${meta}</div>
      <button class="btn small" data-toggle>版本▾</button>
    </div>
    <div class="card-detail hidden"></div>
  </div>`;
}

$('#libList').addEventListener('click', async e=>{
  const card = e.target.closest('.card'); if(!card) return;
  const name = card.dataset.name;

  const vchip = e.target.closest('[data-model]');
  if(vchip) return startPull(vchip.dataset.model);

  const act = e.target.closest('[data-tag-act]');
  if(act){
    const model = act.dataset.tagAct;
    if(act.dataset.cmd==='pull') return startPull(model);
    return copyText(`ollama pull ${model}`);
  }

  const btn = e.target.closest('[data-toggle]');
  if(btn){
    const det = card.querySelector('.card-detail');
    if(det.classList.contains('hidden')){
      det.classList.remove('hidden'); btn.textContent='版本▴';
      if(!det.dataset.loaded) await loadCardDetail(name, det);
    }else{ det.classList.add('hidden'); btn.textContent='版本▾'; }
  }
});

async function loadCardDetail(name, det){
  det.dataset.loaded = '1';
  det.innerHTML = '<div class="loading">获取版本列表</div>';
  const key = name + '|' + (state.hw ? state.hw.ram+'_'+state.hw.vram : 'nohw');
  if(state.libCache.has(key)){ det.innerHTML = state.libCache.get(key); return; }
  try{
    const r = await B.model(name);
    const quick = r.variants.map(v=>{
      const tag = r.tags.find(t=>normRef(t.tag)===normRef(v));
      const full = tag?.model || name+':'+v;
      const status = tag ? tagInstallStatus(tag) : {kind:'none'};
      const label = status.kind==='exact' ? '已安装' : status.kind==='equivalent' ? '同内容已安装' : esc(v);
      const title = status.kind==='exact' ? `已安装：${status.local.name}` : status.kind==='equivalent' ? `同内容已安装为 ${status.local.name}；仍可拉取此标签` : `拉取 ${full}`;
      return `<button class="vchip ${status.kind==='exact'?'installed':''}" ${status.kind==='exact'?'disabled':''} data-model="${esc(full)}" title="${esc(title)}">${label}${tag?pressureDot(tag.size):''}</button>`;
    }).join('');
    const rows = r.tags.map(t=>{
      const status=tagInstallStatus(t);
      const stateLabel=status.kind==='exact'?'<span class="badge" style="color:var(--ok);border-color:#c9dcc0">已安装</span>':status.kind==='equivalent'?`<span class="badge" title="本地：${esc(status.local.name)}">同内容已安装</span>`:'';
      const action=status.kind==='exact'?'<button class="btn small" disabled>已安装</button>':`<button class="btn small primary" data-tag-act="${esc(t.model)}" data-cmd="pull" ${calcPressure(t.size)&&calcPressure(t.size).level===2?'title="提示：本机基本无法运行此版本"':''}>拉取</button>`;
      return `<tr><td class="tname">${esc(t.tag)}</td><td>${esc(t.size)}</td><td>${esc(t.context)}</td>
      <td style="white-space:nowrap">${pressureHTML(t.size)}</td><td>${stateLabel}</td>
      <td>${esc(t.input)}</td><td>${esc(t.updated)}</td><td style="white-space:nowrap">${action}
        <button class="btn small ghost" data-tag-act="${esc(t.model)}" data-cmd="copy" title="复制拉取命令">⧉</button></td></tr>`;
    }).join('');
    let html = '';
    if(quick) html += `<div class="quick"><span class="lbl">快捷拉取（圆点=本机压力）：</span>${quick}</div>`;
    html += `<table class="tag-table">
      <tr><th>版本 Tag</th><th>大小</th><th>上下文</th><th>本机压力</th><th>本地状态</th><th>输入</th><th>更新</th><th></th></tr>${rows}</table>`;
    state.libCache.set(key, html);
    det.innerHTML = html;
  }catch(e){
    det.dataset.loaded='';
    det.innerHTML = `<div class="empty">获取版本失败：${esc(e.message)}<br>
      <button class="btn small primary" data-model="${esc(name)}" style="margin-top:8px">直接拉取 ${esc(name)}</button></div>`;
  }
}

$('#btnSearch').onclick = ()=>loadLibrary($('#q').value.trim());
$('#q').addEventListener('keydown', e=>{ if(e.key==='Enter') loadLibrary($('#q').value.trim()); });
$('#sort').addEventListener('change', ()=>loadLibrary($('#q').value.trim()));
$('#toggleAdvanced').addEventListener('click', ()=>{
  const panel = $('#advancedFilters'); panel.classList.toggle('hidden');
  $('#toggleAdvanced').textContent = panel.classList.contains('hidden') ? '高级筛选 ▾' : '高级筛选 ▴';
});
[['filterUpdated','updated'], ['filterSource','source'], ['filterPulls','minPulls'], ['filterSize','size'], ['filterPressure','pressure']].forEach(([id,key]) => {
  $('#'+id).addEventListener('change', e => { state.filters[key] = key === 'minPulls' ? Number(e.target.value) : e.target.value; loadLibrary($('#q').value.trim()); });
});
function applyCapabilityFilter(chip){
  if(chip.id==='clearCaps'){
    state.caps=[];
    $$('#filters .chip[data-cap]').forEach(c=>c.classList.remove('on'));
  }else{
    const cap = chip.dataset.cap;
    const i = state.caps.indexOf(cap);
    if(i>=0){ state.caps.splice(i,1); chip.classList.remove('on'); }
    else{ state.caps.push(cap); chip.classList.add('on'); }
  }
  loadLibrary($('#q').value.trim());
}
$$('#filters .chip').forEach(chip=>chip.addEventListener('click', ()=>applyCapabilityFilter(chip)));
$('#btnManualPull').onclick = manualPull;
$('#manualPull').addEventListener('keydown', e=>{ if(e.key==='Enter') manualPull(); });
function manualPull(){
  let v = $('#manualPull').value.trim();
  if(!v) return;
  v = v.replace(/^ollama\s+pull\s+/i, '').replace(/\s+--.*$/, '').trim();
  if(!v) return toast('请输入有效的模型名', 'err');
  startPull(v);
  $('#manualPull').value='';
}

/* ================= 下载任务 ================= */
const PHASES = [
  ['pulling manifest','拉取清单'], ['verifying','校验数据'], ['writing manifest','写入清单'],
  ['success','完成'], ['canceling','取消中'],
];
const phaseText = s => {
  for(const [k,v] of PHASES) if(String(s||'').includes(k)) return v;
  return s;
};

function startPull(model){
  if(pulls.has(model)) return toast(`「${model}」已在下载队列中`);
  const task = { model, done:false, cancelled:false, cancelling:false, error:'', status:'连接中…', pct:0, completed:0, total:0, speed:0, _lt:0, _lc:0 };
  pulls.set(model, task);
  renderPulls();
  switchTab('installed');
  task.handle = B.pull(model, {
    onLine: ev => {
      task.status = ev.status || task.status;
      if(ev.completed && ev.total){
        const now = Date.now();
        if(task._lt && ev.completed > task._lc){
          const inst = (ev.completed - task._lc) / Math.max(0.001, (now - task._lt)/1000);
          task.speed = task.speed ? task.speed*0.6 + inst*0.4 : inst;
        }
        task._lt = now; task._lc = ev.completed;
        task.completed = ev.completed; task.total = ev.total;
        task.pct = Math.min(100, ev.completed/ev.total*100);
      }
      if(ev.error){ task.error = ev.error; task.status = '失败：'+ev.error; }
      if(ev.status === 'success'){ task.done = true; task.pct = 100; task.status='完成'; }
      renderPulls();
    },
    onEnd: result => {
      if(result?.cancelled || task.cancelling){ task.cancelled=true; task.status='已取消（Ollama 将自行清理未完成临时数据）'; }
      else if(result && !task.done){ task.error = result.message || String(result); task.status = '失败：'+task.error; }
      else if(!task.done){ task.status = task.status || '已结束'; }
      task.done = true; task.doneAt = Date.now();
      renderPulls();
      if(task.cancelled){ toast(`已取消 ${model}`); loadInstalled(); }
      else if(!task.error){ toast(`「${model}」下载完成`, 'ok'); state.libCache.clear(); loadInstalled(); loadRunning(); }
    },
  });
}

function renderPulls(){
  const list = $('#pullList'), panel = $('#pulls');
  panel.classList.toggle('hidden', pulls.size===0);
  const parts = [];
  for(const t of pulls.values()){
    let status;
    if(t.error) status = esc(t.status);
    else if(t.cancelled) status = '已取消';
    else if(t.cancelling) status = '取消中…';
    else if(t.done) status = '✓ 完成';
    else if(t.pct > 0){
      status = `下载中 ${t.pct.toFixed(0)}% · ${fmtSize(t.completed)} / ${fmtSize(t.total)}` + (t.speed>1024? ` · ${fmtSize(t.speed)}/s`:'');
    } else status = esc(phaseText(t.status));
    const indet = (!t.done && !t.error && t.pct===0);
    parts.push(`<div class="pull-item ${t.done&&!t.error?'done':''} ${t.error?'err':''}">
      <div class="p-top"><span class="p-name">${esc(t.model)}</span>
        ${t.done ? (t.error?'<span style="color:var(--danger)">!</span>':'<span style="color:var(--ok)">✓</span>') : ''}
      </div>
      <div class="p-status">${status}</div>
      <div class="p-bar"><i class="${indet?'indet':''}" style="${indet?'':'width:'+t.pct.toFixed(1)+'%'}"></i></div>
    </div>`);
  }
  list.innerHTML = parts.join('');
}

$('#clearDone').onclick = ()=>{
  for(const [k,t] of pulls) if(t.done) pulls.delete(k);
  renderPulls();
};
setInterval(()=>{
  let dirty=false;
  for(const [k,t] of pulls){
    if(t.done && !t.error && t.doneAt && Date.now()-t.doneAt > 8000){ pulls.delete(k); dirty=true; }
  }
  if(dirty) renderPulls();
}, 2000);

/* ================= 运行中 ================= */
async function loadRunning(){
  const box = $('#runList');
  try{
    const j = await B.ollama('/api/ps');
    state.running = j.models||[];
    $('#cntRunning').textContent = state.running.length || '';
    $('#runSummary').textContent = state.running.length ? `${state.running.length} 个` : '';
    if(!state.running.length){
      box.innerHTML = '<div class="empty">当前没有加载到内存的模型。<br>对话或调用 API 时模型会自动加载。</div>';
      return;
    }
    box.innerHTML = state.running.map(m=>{
      const d = m.details||{};
      const left = m.expires_at ? Math.max(0, new Date(m.expires_at) - Date.now()) : 0;
      const leftTxt = left>0 ? `${Math.ceil(left/60000)} 分钟后自动卸载` : '即将卸载';
      return `<div class="row" data-name="${esc(m.name)}">
        <div class="row-main">
          <div class="m-name">${esc(m.name)}</div>
          <div class="badges">
            ${d.parameter_size?`<span class="badge b">${esc(d.parameter_size)}</span>`:''}
            <span class="badge">${fmtSize(m.size_vram)} 显存/内存</span>
            <span class="badge">${leftTxt}</span>
          </div>
        </div>
        <div class="proc">${esc(m.processor||'')}</div>
        <div class="row-actions"><button class="btn small danger" data-unload="1">立即卸载</button></div>
      </div>`;
    }).join('');
  }catch(e){
    box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}
$('#runList').addEventListener('click', async e=>{
  const btn = e.target.closest('[data-unload]'); if(!btn) return;
  const name = btn.closest('.row').dataset.name;
  btn.disabled = true;
  try{
    await B.ollama('/api/generate', 'POST', {model:name, keep_alive:0});
    toast(`已请求卸载 ${name}`, 'ok');
  }catch(err){
    toast(`已发送卸载请求（${err.message}）`);
  }
  setTimeout(loadRunning, 800);
});

/* ================= 本地聊天 ================= */
const CHAT_KEY='oh_chat_v1';
const chat={sessions:[],active:null,handle:null,streaming:false};
function chatLoad(){try{const d=JSON.parse(localStorage.getItem(CHAT_KEY)||'{}');chat.sessions=Array.isArray(d.sessions)?d.sessions.slice(0,30):[];chat.active=d.active||chat.sessions[0]?.id||null}catch{chat.sessions=[];chat.active=null}}
function chatSave(){localStorage.setItem(CHAT_KEY,JSON.stringify({active:chat.active,sessions:chat.sessions.slice(0,30)}))}
function chatSession(){return chat.sessions.find(s=>s.id===chat.active)}
function eligibleModels(){return state.models.filter(m=>{const d=m.details||{},c=(m.capabilities||d.capabilities||[]).map(x=>String(x).toLowerCase());return !c.includes('embedding')})}
function newChat(){const models=eligibleModels();const s={id:crypto.randomUUID(),title:'新对话',model:models[0]?.name||'',system:'',temperature:.7,messages:[],createdAt:Date.now(),updatedAt:Date.now()};chat.sessions.unshift(s);chat.active=s.id;chatSave();renderChat()}
function renderChat(){
  const box=$('#chatSessions'),session=chatSession(),models=eligibleModels();
  if(!session&&models.length)newChat();
  box.innerHTML=chat.sessions.map(s=>`<button class="chat-session ${s.id===chat.active?'active':''}" data-chat-session="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title)}</button>`).join('')||'<div class="empty">暂无对话</div>';
  const select=$('#chatModel');select.innerHTML=models.map(m=>`<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
  if(session&&models.some(m=>m.name===session.model))select.value=session.model;
  const out=$('#chatMessages');out.replaceChildren();
  if(!models.length){const e=document.createElement('div');e.className='empty';e.textContent='没有可聊天的本地模型。Embedding 向量模型不能用于对话，请到模型市场安装聊天模型。';out.append(e);$('#chatSend').disabled=true;return}
  $('#chatSend').disabled=chat.streaming;$('#chatInput').disabled=chat.streaming;$('#chatStop').classList.toggle('hidden',!chat.streaming);
  (session?.messages||[]).forEach(m=>appendChatMessage(m.role,m.content,m.error));
  if(!session?.messages?.length){const e=document.createElement('div');e.className='empty';e.textContent='开始一段本地对话。聊天记录仅保存在此浏览器。';out.append(e)}
  out.scrollTop=out.scrollHeight;
}
function appendChatMessage(role,content,error=false){const out=$('#chatMessages');const empty=out.querySelector('.empty');if(empty)empty.remove();const wrap=document.createElement('div');wrap.className=`chat-message ${role}${error?' error':''}`;const r=document.createElement('div');r.className='role';r.textContent=role==='user'?'你':role==='assistant'?'助手':'系统';const b=document.createElement('div');b.className='bubble';b.textContent=content||'';wrap.append(r,b);out.append(wrap);out.scrollTop=out.scrollHeight;return b}
function updateChatTitle(s){const first=s.messages.find(m=>m.role==='user')?.content||'新对话';s.title=first.replace(/\s+/g,' ').slice(0,24);s.updatedAt=Date.now()}
async function sendChat(){
  const s=chatSession(),text=$('#chatInput').value.trim();if(!s||!text||chat.streaming)return;
  const model=$('#chatModel').value;if(!model)return toast('请选择聊天模型','err');
  s.model=model;s.messages.push({role:'user',content:text,createdAt:Date.now()});$('#chatInput').value='';updateChatTitle(s);chat.streaming=true;renderChat();
  const assistant={role:'assistant',content:'',createdAt:Date.now()};s.messages.push(assistant);const bubble=appendChatMessage('assistant','');
  const msgs=[];if(s.system.trim())msgs.push({role:'system',content:s.system.trim()});msgs.push(...s.messages.filter(m=>m!==assistant).slice(-100).map(m=>({role:m.role,content:m.content})));
  $('#chatStatus').textContent='正在生成…';let final={};
  chat.handle=B.chat({model,messages:msgs,keep_alive:'5m',options:{temperature:Number(s.temperature)||.7}},{onLine:ev=>{assistant.content+=ev.message?.content||'';bubble.textContent=assistant.content;final=ev;if(ev.done){const sec=(ev.eval_duration||0)/1e9;const t=ev.eval_count&&sec?`${(ev.eval_count/sec).toFixed(1)} tok/s`:'';$('#chatStats').textContent=t}},onEnd:result=>{chat.streaming=false;chat.handle=null;if(result?.cancelled){assistant.content+=assistant.content?'\n\n[已停止生成]':'[已停止生成]'}else if(result){assistant.error=true;assistant.content+=`\n\n[错误：${result.message||result}]`;$('#chatStatus').textContent='生成失败'}else $('#chatStatus').textContent='';updateChatTitle(s);chatSave();renderChat()}});
}
$('#chatSessions').addEventListener('click',e=>{const b=e.target.closest('[data-chat-session]');if(b){chat.active=b.dataset.chatSession;chatSave();renderChat()}});
$('#chatNew').addEventListener('click',newChat);
$('#chatModel').addEventListener('change',e=>{const s=chatSession();if(s){s.model=e.target.value;chatSave()}});
$('#chatSend').addEventListener('click',sendChat);
$('#chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat()}});
$('#chatStop').addEventListener('click',()=>{if(chat.handle){chat.handle.cancel();$('#chatStatus').textContent='正在停止…'}});
$('#chatRename').addEventListener('click',()=>{const s=chatSession();if(!s)return;const n=prompt('对话名称',s.title);if(n?.trim()){s.title=n.trim().slice(0,60);chatSave();renderChat()}});
$('#chatDelete').addEventListener('click',()=>{const s=chatSession();if(!s||!confirm(`删除对话“${s.title}”？`))return;chat.sessions=chat.sessions.filter(x=>x.id!==s.id);chat.active=chat.sessions[0]?.id||null;chatSave();renderChat()});
$('#chatSettings').addEventListener('click',()=>{const s=chatSession();if(!s)return;openModal(`<h3>对话设置</h3><label>系统提示词</label><textarea id="systemPrompt" rows="6" style="width:100%;margin-top:6px">${esc(s.system)}</textarea><label style="display:block;margin-top:12px">温度（0–2）</label><input id="chatTemp" type="number" min="0" max="2" step="0.1" value="${esc(s.temperature)}"><div class="modal-actions"><button class="btn" data-close>取消</button><button class="btn primary" id="saveChatSettings">保存</button></div>`);$('#saveChatSettings').addEventListener('click',()=>{s.system=$('#systemPrompt').value.slice(0,12000);s.temperature=Math.min(2,Math.max(0,Number($('#chatTemp').value)||.7));chatSave();closeModal()})});
chatLoad();

/* ================= 弹窗 / 选项卡 ================= */
function openModal(html){ $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal(){ $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', e=>{
  if(e.target.id==='modal' || e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });

function switchTab(id){
  $$('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===id));
  $$('.pane').forEach(p=>p.classList.toggle('active', p.id==='pane-'+id));
}
$$('.tab').forEach(t=>t.addEventListener('click', ()=>{
  switchTab(t.dataset.tab);
  if(t.dataset.tab==='running') loadRunning();
  if(t.dataset.tab==='chat'){ loadInstalled().then(renderChat); }
  if(t.dataset.tab==='help') renderHwUI();
}));
$('#hwPill').onclick = ()=>switchTab('help');

$('#hwSave').onclick = ()=>{
  const ram = parseFloat($('#hwRam').value), vram = parseFloat($('#hwVram').value)||0;
  if(!ram || ram<=0) return toast('请填写有效的内存大小', 'err');
  state.hw = { ram, vram };
  localStorage.setItem('oh_hw', JSON.stringify(state.hw));
  refreshAfterHwChange();
  toast('已保存硬件设置', 'ok');
};
$('#hwReset').onclick = ()=>{
  localStorage.removeItem('oh_hw');
  state.hw = state.hwAuto;
  refreshAfterHwChange();
  toast('已恢复自动检测' + (state.hw ? '' : '（暂无检测结果，请手动填写）'));
};
$('#hwRedetect').onclick = async ()=>{
  if(IS_EXT) return toast('浏览器扩展无法读取本机硬件，请手动填写 RAM/VRAM');
  $('#hwRedetect').disabled = true;
  state.hwAuto = await B.hardware();
  if(!localStorage.getItem('oh_hw')) state.hw = state.hwAuto;
  refreshAfterHwChange();
  $('#hwRedetect').disabled = false;
  toast(state.hwAuto ? '已重新检测本机硬件并重算压力' : '未能检测硬件，请手动填写', state.hwAuto ? 'ok' : 'err');
};
function refreshAfterHwChange(){
  renderHwUI();
  state.libCache.clear();
  loadInstalled();
  loadLibrary($('#q').value.trim());
}

$('#refreshAll').onclick = ()=>{ checkStatus(); loadInstalled(); loadRunning(); };
$('#retryConn').onclick = checkStatus;

/* ================= 启动 ================= */
(async () => {
  loadHardware();
  state.hwAuto = await B.hardware();
  if(!state.hw) state.hw = state.hwAuto;
  renderHwUI();
})();
checkStatus();
loadInstalled();
loadRunning();
loadLibrary('');
setInterval(checkStatus, 30000);
setInterval(loadRunning, 5000);
