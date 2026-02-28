// ==UserScript==
// @name         网页内容对齐助手
// @namespace    https://github.com/eli
// @version      15.0.0
// @description  网页内容对齐 + 阅读辅助（中英文仿生阅读、阅读尺、段落彩条等）
// @author       eli
// @license      MIT
// @homepage     https://github.com/eli/content-align
// @match        *://*/*
// @exclude      *://*.youtube.com/*
// @exclude      *://*.netflix.com/*
// @exclude      *://*.twitch.tv/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @icon         data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>◧</text></svg>
// ==/UserScript==

(function () {
  'use strict';

  const LOCK_DELAY = 300;

  const CONTENT_MODES = [
    { id: 'original',   icon: '⬜', label: '原始',   desc: '恢复默认' },
    { id: 'center',     icon: '⬛', label: '居中',   desc: '内容居中显示' },
    { id: 'shift-right',icon: '▶',  label: '右移',   desc: '整体向右平移' },
    { id: 'focus',      icon: '◎',  label: '聚焦',   desc: '鼠标所在内容区不变，其余虚化' },
    { id: 'mouse-track',icon: '⊙',  label: '跟踪',   desc: '聚焦+居中锁定（300ms触发，双击解锁）' },
  ];
  const CONTENT_MAP = Object.fromEntries(CONTENT_MODES.map(m => [m.id, m]));

  // 阅读辅助模式：可叠加，每个独立开关
  const READ_MODES = [
    { id: 'read-off',  icon: '📖', label: '关闭全部', desc: '关闭所有阅读辅助' },
    { id: 'bionic',    icon: '🧠', label: '仿生阅读', desc: '单词/短语前半加粗（中英文自适应）' },
    { id: 'ruler',     icon: '📏', label: '阅读尺',   desc: '高亮条跟随鼠标，防止跳行' },
    { id: 'zebra',     icon: '🎨', label: '段落彩条', desc: '相邻段落交替柔和背景色，视觉分块' },
    { id: 'calm-bg',   icon: '🌙', label: '舒缓背景', desc: '护眼色背景+优化排版' },
  ];
  const READ_MAP = Object.fromEntries(READ_MODES.map(m => [m.id, m]));

  const STORAGE_KEY = 'content-align-preferences';
  const hostname = location.hostname;

  // 内容对齐状态
  let contentMode = 'original';
  let activeHandler = null;
  let activeUnlock = null;
  let lockTimer = null;

  // 阅读辅助状态（可叠加，用 Set 存储已开启的模式）
  let readActive = new Set();
  let readHandlers = [];
  let rulerEl = null;

  // 节流：避免 mousemove 高频触发导致闪烁和性能问题
  function throttle(fn, ms) {
    let last = 0;
    return function(...args) {
      const now = Date.now();
      if (now - last >= ms) { last = now; fn.apply(this, args); }
    };
  }

  // ============================================================
  // 存储
  // ============================================================
  function getPrefs() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
  }
  function savePref(key, val) {
    const p = getPrefs(); p[key] = val;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  }

  // 仿生阅读配置
  const BIONIC_KEY = 'content-align-bionic-config';
  const BIONIC_DEFAULTS = { fixation: 1, saccades: 0, fade: true };
  function getBionicConfig() {
    try { return { ...BIONIC_DEFAULTS, ...JSON.parse(localStorage.getItem(BIONIC_KEY) || '{}') }; }
    catch { return { ...BIONIC_DEFAULTS }; }
  }
  function saveBionicConfig(cfg) { localStorage.setItem(BIONIC_KEY, JSON.stringify(cfg)); }

  // ============================================================
  // 样式
  // ============================================================
  let contentStyleEl = null;
  let readStyleEl = null;
  function ensureContentStyle() {
    if (!contentStyleEl) { contentStyleEl = document.createElement('style'); contentStyleEl.id = '__ca_content_style__'; document.head.appendChild(contentStyleEl); }
  }
  function clearContentStyle() {
    if (contentStyleEl) { contentStyleEl.textContent = ''; contentStyleEl.remove(); contentStyleEl = null; }
    document.documentElement.style.overflowX = '';
  }
  function ensureReadStyle() {
    if (!readStyleEl) { readStyleEl = document.createElement('style'); readStyleEl.id = '__ca_read_style__'; document.head.appendChild(readStyleEl); }
  }
  function clearReadStyle() {
    if (readStyleEl) { readStyleEl.textContent = ''; readStyleEl.remove(); readStyleEl = null; }
  }

  // ============================================================
  // 内容对齐：清理
  // ============================================================
  function cleanupContent() {
    if (activeHandler) {
      document.removeEventListener('mousemove', activeHandler, { passive: true });
      document.removeEventListener('mouseover', activeHandler, { passive: true });
      if (activeHandler._clickBlocker) document.removeEventListener('click', activeHandler._clickBlocker, { capture: true });
      activeHandler = null;
    }
    if (activeUnlock) { document.removeEventListener('dblclick', activeUnlock, { passive: true }); activeUnlock = null; }
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
    document.querySelectorAll('[data-ca-managed]').forEach((el) => {
      el.style.transition = ''; el.style.transform = '';
      el.style.opacity = ''; el.style.zIndex = '';
      el.style.filter = ''; el.style.background = '';
      el.style.boxShadow = ''; el.style.outline = '';
      el.style.outlineOffset = ''; el.style.borderRadius = '';
      el.style.position = '';
      el.removeAttribute('data-ca-managed');
    });
    clearContentStyle();
  }

  // ============================================================
  // 阅读辅助：清理所有
  // ============================================================
  function cleanupAllRead() {
    for (const h of readHandlers) {
      document.removeEventListener('mousemove', h, { passive: true });
    }
    readHandlers = [];
    if (rulerEl) { rulerEl.remove(); rulerEl = null; }
    // 仿生阅读
    document.querySelectorAll('[data-ca-bionic]').forEach((el) => {
      const parent = el.parentNode;
      if (parent) { parent.replaceChild(document.createTextNode(el.textContent), el); parent.normalize(); }
    });
    // 段落彩条
    document.querySelectorAll('[data-ca-zebra]').forEach((el) => {
      el.style.background = ''; el.style.transition = '';
      el.removeAttribute('data-ca-zebra');
    });
    // 恢复舒缓背景
    document.body.style.backgroundColor = '';
    document.body.style.color = '';
    document.body.style.transition = '';
    readActive.clear();
    clearReadStyle();
  }

  // ============================================================
  // 关闭单个阅读模式
  // ============================================================
  function disableReadMode(mode) {
    if (mode === 'ruler' && rulerEl) { rulerEl.remove(); rulerEl = null; }
    if (mode === 'bionic') {
      document.querySelectorAll('[data-ca-bionic]').forEach((el) => {
        const parent = el.parentNode;
        if (parent) { parent.replaceChild(document.createTextNode(el.textContent), el); parent.normalize(); }
      });
    }
    if (mode === 'zebra') {
      document.querySelectorAll('[data-ca-zebra]').forEach((el) => {
        el.style.background = ''; el.style.transition = '';
        el.removeAttribute('data-ca-zebra');
      });
    }
    if (mode === 'calm-bg') {
      document.body.style.backgroundColor = '';
      document.body.style.color = '';
      document.body.style.transition = '';
      document.body.querySelectorAll('*').forEach(el => {
        if (el.tagName === 'A') el.style.color = '';
      });
    }
    readActive.delete(mode);
    rebuildReadStyle();
  }

  // ============================================================
  // 重新构建阅读辅助样式（所有激活模式的叠加）
  // ============================================================
  function rebuildReadStyle() {
    if (readActive.size === 0) { clearReadStyle(); return; }
    ensureReadStyle();
    let css = '';

    if (readActive.has('bionic')) {
      css += `[data-ca-bionic] { font-weight: inherit !important; } [data-ca-bionic] b { font-weight: 900 !important; } [data-ca-bionic] i { font-style: normal !important; opacity: 0.75 !important; }`;
    }
    if (readActive.has('zebra')) {
      css += `[data-ca-zebra] { transition: opacity 0.15s ease-out, background 0.15s ease-out !important; }`;
    }
    if (readActive.has('calm-bg')) {
      css += `::selection { background: rgba(79, 195, 247, 0.3) !important; }`;
    }
    readStyleEl.textContent = css;
  }

  // ============================================================
  // 区块检测（内容对齐用）
  // ============================================================
  function isSignificantBlock(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el === document.body || el === document.documentElement) return false;
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'absolute') return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.display === 'inline') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 60) return false;
    return true;
  }

  function countSignificantChildren(el) {
    let count = 0;
    for (const child of el.children) {
      if (!isSignificantBlock(child)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width >= 80 && rect.height >= 60) count++;
    }
    return count;
  }

  function findContentBlockAtPoint(x, y) {
    const managed = document.querySelectorAll('[data-ca-managed]');
    managed.forEach(el => { el.style.transform = 'none'; });
    let startEl = document.elementFromPoint(x, y);
    managed.forEach(el => { el.style.transform = ''; });
    if (!startEl) return null;
    let current = startEl, fallback = null;
    while (current && current !== document.body && current !== document.documentElement) {
      if (!isSignificantBlock(current)) { current = current.parentElement; continue; }
      const rect = current.getBoundingClientRect();
      if (!(x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
        current = current.parentElement; continue;
      }
      if (!fallback) fallback = current;
      const parent = current.parentElement;
      if (!parent) { current = current.parentElement; continue; }
      const siblingCount = countSignificantChildren(parent);
      if (siblingCount >= 2 && siblingCount <= 6) return current;
      if (siblingCount >= 7) return current;
      current = current.parentElement;
    }
    return fallback;
  }

  // ============================================================
  // 虚化（内容对齐用）
  // ============================================================
  function clearManaged() {
    document.querySelectorAll('[data-ca-managed]').forEach(el => {
      el.style.opacity = ''; el.style.transform = '';
      el.style.zIndex = ''; el.style.filter = '';
      el.style.background = ''; el.style.boxShadow = '';
      el.style.outline = ''; el.style.outlineOffset = '';
      el.style.borderRadius = ''; el.style.position = '';
      el.removeAttribute('data-ca-managed');
    });
  }

  function dimSiblings(block) {
    const parent = block.parentElement;
    if (!parent) return;
    for (const sib of parent.children) {
      if (sib === block) continue;
      const st = getComputedStyle(sib);
      if (st.position === 'fixed' || st.position === 'absolute' || st.display === 'none') continue;
      sib.setAttribute('data-ca-managed', '1');
      sib.style.filter = 'blur(12px) brightness(0.4) saturate(0.3)';
      sib.style.opacity = '0.6';
    }
  }

  function dimAncestorSiblings(block) {
    let ancestor = block.parentElement;
    while (ancestor && ancestor !== document.body) {
      for (const sib of ancestor.children) {
        if (sib === ancestor || sib.contains(block)) continue;
        const st = getComputedStyle(sib);
        if (st.position === 'fixed' || st.position === 'absolute' || st.display === 'none') continue;
        if (!sib.hasAttribute('data-ca-managed')) {
          sib.setAttribute('data-ca-managed', '1');
          sib.style.filter = 'blur(12px) brightness(0.4) saturate(0.3)';
          sib.style.opacity = '0.6';
        }
      }
      ancestor = ancestor.parentElement;
    }
  }

  // ============================================================
  // 内容对齐：聚焦
  // ============================================================
  function applyContentFocus() {
    ensureContentStyle();
    contentStyleEl.textContent = `[data-ca-managed] { transition: opacity 0.2s ease-out, filter 0.3s ease-out !important; }`;
    let lastFocused = null;
    const handler = (e) => {
      const block = findContentBlockAtPoint(e.clientX, e.clientY);
      if (!block || block === lastFocused) return;
      clearManaged(); lastFocused = block;
      dimSiblings(block); dimAncestorSiblings(block);
    };
    activeHandler = throttle(handler, 30);
    document.addEventListener('mousemove', activeHandler, { passive: true });
  }

  // ============================================================
  // 内容对齐：跟踪
  // ============================================================
  function applyContentTrack() {
    ensureContentStyle();
    contentStyleEl.textContent = `[data-ca-managed] { transition: opacity 0.2s ease-out, transform 0.3s ease-out, filter 0.3s ease-out !important; }`;
    let locked = false, currentCandidate = null, activeBlock = null;
    const clickBlocker = (e) => {
      let target = e.target;
      while (target && target !== document.body) {
        if (target.hasAttribute && target.hasAttribute('data-ca-managed')) {
          if (activeBlock && activeBlock.contains(target)) return;
          e.preventDefault(); e.stopPropagation(); return;
        }
        target = target.parentElement;
      }
    };
    document.addEventListener('click', clickBlocker, { capture: true, passive: false });
    const handler = (e) => {
      if (locked) return;
      const block = findContentBlockAtPoint(e.clientX, e.clientY);
      if (!block || !isSignificantBlock(block)) {
        if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
        currentCandidate = null; return;
      }
      if (block === currentCandidate) return;
      currentCandidate = block;
      if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
      clearManaged(); dimSiblings(block); dimAncestorSiblings(block);
      block.setAttribute('data-ca-managed', '1');
      block.style.outline = '3px solid rgba(79, 195, 247, 0.9)';
      block.style.outlineOffset = '4px';
      block.style.borderRadius = '8px';
      lockTimer = setTimeout(() => {
        if (locked || currentCandidate !== block) return;
        locked = true; lockTimer = null; activeBlock = block;
        block.style.outline = ''; block.style.outlineOffset = '';
        const rect = block.getBoundingClientRect();
        const shift = (window.innerWidth - rect.width) / 2 - rect.left;
        block.style.transform = `translateX(${shift}px)`;
        block.style.boxShadow = '0 0 40px rgba(0,0,0,0.3)';
        block.style.borderRadius = '8px';
        block.style.position = 'relative'; block.style.zIndex = '10';
      }, LOCK_DELAY);
    };
    activeUnlock = () => {
      if (!locked) {
        if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
        currentCandidate = null; clearManaged(); return;
      }
      locked = false; currentCandidate = null; activeBlock = null;
      document.querySelectorAll('[data-ca-managed]').forEach((el) => {
        el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        el.style.transform = ''; el.style.opacity = ''; el.style.zIndex = '';
        el.style.filter = ''; el.style.background = '';
        el.style.boxShadow = ''; el.style.borderRadius = '';
        el.style.position = '';
        el.removeAttribute('data-ca-managed');
      });
    };
    activeHandler = throttle(handler, 30);
    document.addEventListener('mousemove', activeHandler, { passive: true });
    document.addEventListener('dblclick', activeUnlock, { passive: true });
    activeHandler._clickBlocker = clickBlocker;
  }

  function applyContentMode(mode) {
    cleanupContent(); contentMode = mode; savePref('content', mode);
    if (mode === 'original') { updateContentButton(); return; }
    ensureContentStyle();
    if (mode === 'center') {
      contentStyleEl.textContent = `body { max-width: 90vw !important; margin-left: auto !important; margin-right: auto !important; transition: all 0.3s ease !important; }`;
    } else if (mode === 'shift-right') {
      contentStyleEl.textContent = `html { overflow-x: hidden !important; } body { transform: translateX(15vw) !important; transform-origin: top left !important; transition: transform 0.3s ease !important; }`;
    } else if (mode === 'focus') {
      applyContentFocus();
    } else if (mode === 'mouse-track') {
      applyContentTrack();
    }
    updateContentButton();
  }

  // ============================================================
  // 阅读辅助：仿生阅读（中英文自适应）
  // ============================================================
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'SVG', 'MATH']);

  // 检测是否为 CJK 字符
  function isCJK(ch) {
    const code = ch.charCodeAt(0);
    return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
           (code >= 0x20000 && code <= 0x2A6DF) || (code >= 0x2A700 && code <= 0x2B73F) ||
           (code >= 0xF900 && code <= 0xFAFF) || (code >= 0x2F800 && code <= 0x2FA1F) ||
           (code >= 0x3000 && code <= 0x303F) || (code >= 0xFF00 && code <= 0xFFEF);
  }

  // 中文虚词切分词表：在这些字符后断句，将长句拆成更小语义单元
  const CJK_SPLIT_CHARS = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '看', '好',
    '这', '他', '她', '它', '们', '那', '被', '从', '把', '让', '用', '为',
    '以', '所', '能', '可', '而', '但', '如果', '因为', '所以', '虽然',
    '不过', '然后', '或者', '以及', '还是', '只是', '什么', '怎么',
    '与', '及', '或', '且', '之', '其', '此', '于', '则', '乃', '即',
    '过', '地', '得', '吗', '呢', '吧', '啊', '哦', '哈', '呀', '嘛', '啦', '嗯',
  ]);

  // 智能分词：英文按空格，中文按标点、虚词和语义边界
  function tokenize(text) {
    const tokens = [];
    let current = '';
    let lastWasCJK = null;

    function flush() { if (current) { tokens.push(current); current = ''; } }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const nowCJK = isCJK(ch);
      const isSpace = /\s/.test(ch);
      const isPunctuation = /[，。！？、；：\"‘’“”（）【】《》…—\-,.!?;:'"()\[\]<>]/.test(ch);

      if (isSpace) { flush(); tokens.push(ch); lastWasCJK = null; continue; }
      if (isPunctuation) { flush(); tokens.push(ch); lastWasCJK = null; continue; }

      if (lastWasCJK !== null && nowCJK !== lastWasCJK && current) { flush(); }

      if (nowCJK && CJK_SPLIT_CHARS.has(ch) && current && current.length >= 1) {
        current += ch; flush(); lastWasCJK = nowCJK; continue;
      }

      current += ch;
      lastWasCJK = nowCJK;
    }
    flush();
    return tokens;
  }

  function bionicTransform(word, wordIdx) {
    if (/^\s+$/.test(word)) return word;
    if (/^[，。！？、；：\"''""（）【】《》…—\-,.!?;:'"()\[\]<>]+$/.test(word)) return word;

    const cfg = getBionicConfig();
    // Saccades: skip every N words
    if (cfg.saccades > 0 && wordIdx !== undefined && wordIdx % (cfg.saccades + 1) !== 0) {
      return `<span data-ca-bionic="1">${word}</span>`;
    }

    const len = word.length;
    const f = cfg.fixation; // fixation multiplier
    let boldLen;
    if (isCJK(word[0])) {
      boldLen = len <= 2 ? 1 : Math.min(Math.ceil(len * 0.5), Math.ceil(len * 0.5 * f));
    } else {
      if (len <= 1) boldLen = 0;
      else if (len <= 3) boldLen = 1;
      else if (len <= 4) boldLen = Math.max(2, Math.ceil(2 * f));
      else boldLen = Math.max(1, Math.ceil(len * 0.4 * f));
    }
    boldLen = Math.min(boldLen, len);
    if (boldLen === 0) return `<span data-ca-bionic="1">${word}</span>`;
    if (!cfg.fade) return `<span data-ca-bionic="1"><b>${word.slice(0, boldLen)}</b>${word.slice(boldLen)}</span>`;
    return `<span data-ca-bionic="1"><b>${word.slice(0, boldLen)}</b><i>${word.slice(boldLen)}</i></span>`;
  }


  function applyBionic() {
    ensureReadStyle();
    rebuildReadStyle();

    function walkAndBionic(node) {
      if (node.nodeType !== Node.TEXT_NODE) return;
      if (SKIP_TAGS.has(node.parentElement?.tagName)) return;
      if (node.parentElement?.hasAttribute('data-ca-bionic')) return;
      const text = node.textContent;
      if (!text || !text.trim()) return;

      const tokens = tokenize(text);
      let wordIdx = 0;
      const html = tokens.map(t => { const i = wordIdx; if (!/^\s+$/.test(t) && !/^[，。！？]/.test(t)) wordIdx++; return bionicTransform(t, i); }).join('');
      const span = document.createElement('span');
      span.innerHTML = html;
      node.parentNode.replaceChild(span, node);
    }

    function walkDOM(el) {
      if (el.nodeType === Node.TEXT_NODE) { walkAndBionic(el); return; }
      if (el.nodeType !== Node.ELEMENT_NODE) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.hasAttribute('data-ca-bionic')) return;
      for (const child of [...el.childNodes]) walkDOM(child);
    }

    walkDOM(document.body);
  }

  // ============================================================
  // 阅读辅助：阅读尺
  // ============================================================
  function applyRuler() {
    rulerEl = document.createElement('div');
    rulerEl.id = '__ca_ruler__';
    Object.assign(rulerEl.style, {
      position: 'fixed', left: '0', width: '100vw', height: '28px',
      background: 'rgba(79, 195, 247, 0.12)',
      borderTop: '1px solid rgba(79, 195, 247, 0.3)',
      borderBottom: '1px solid rgba(79, 195, 247, 0.3)',
      pointerEvents: 'none', zIndex: '2147483646',
      transition: 'top 0.05s linear',
    });
    document.documentElement.appendChild(rulerEl);
    const h = (e) => { if (rulerEl) rulerEl.style.top = (e.clientY - 14) + 'px'; };
    document.addEventListener('mousemove', h, { passive: true });
    readHandlers.push(h);
  }

  // ============================================================
  // 阅读辅助：段落彩条
  // ============================================================
  const ZEBRA_COLORS = [
    'rgba(79, 195, 247, 0.06)',
    'rgba(129, 199, 132, 0.06)',
    'rgba(255, 213, 79, 0.06)',
    'rgba(206, 147, 216, 0.06)',
    'rgba(255, 138, 101, 0.06)',
  ];

  function applyZebra() {
    rebuildReadStyle();
    const paragraphs = document.querySelectorAll('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6');
    let idx = 0;
    paragraphs.forEach(el => {
      if (el.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')) return;
      if (el.offsetWidth < 100) return;
      el.setAttribute('data-ca-zebra', '1');
      el.style.background = ZEBRA_COLORS[idx % ZEBRA_COLORS.length];
      el.style.borderRadius = '4px';
      el.style.padding = '2px 6px';
      idx++;
    });
  }

  // ============================================================
  // 阅读辅助：舒缓背景
  // ============================================================
  function applyCalmBg() {
    // 直接设置 body inline style（比 CSS 注入更可靠）
    document.body.style.backgroundColor = '#f5f0e8';
    document.body.style.color = '#3d3425';
    document.body.style.transition = 'background-color 0.3s ease, color 0.3s ease';
    // 处理子元素颜色
    document.body.querySelectorAll('*').forEach(el => {
      if (el.closest('[data-ca-managed]')) return;
      if (el.tagName === 'A') { el.style.color = '#5a7d9a'; return; }
      const computed = getComputedStyle(el);
      // 只改继承颜色的元素（不改已有明确颜色的）
      if (computed.color === 'rgb(0, 0, 0)' || computed.color === computed.getPropertyValue('--text-color')) {
        el.style.color = '#3d3425';
      }
    });
    rebuildReadStyle();
  }

  // ============================================================
  // 切换单个阅读模式（叠加）
  // ============================================================
  function toggleReadMode(mode) {
    if (mode === 'read-off') {
      cleanupAllRead();
      updateReadButton();
      savePref('read', []);
      return;
    }

    if (readActive.has(mode)) {
      // 已开启 → 关闭
      disableReadMode(mode);
    } else {
      // 开启
      readActive.add(mode);
      if (mode === 'bionic') applyBionic();
      else if (mode === 'ruler') applyRuler();
      else if (mode === 'zebra') applyZebra();
      else if (mode === 'calm-bg') applyCalmBg();
      rebuildReadStyle();
    }

    savePref('read', [...readActive]);
    updateReadButton();
  }

  // ============================================================
  // UI
  // ============================================================
  let contentMenuOpen = false, readMenuOpen = false;
  const mountPoint = () => document.documentElement || document.head;

  function createContentButton() {
    const btn = document.createElement('div');
    btn.id = '__ca_content_btn__';
    const m = CONTENT_MAP[contentMode] || CONTENT_MAP.original;
    btn.innerHTML = `<span id="__ca_content_icon__">${m.icon}</span>`;
    Object.assign(btn.style, {
      position: 'fixed', bottom: '20px', right: '0',
      width: '40px', height: '40px', borderRadius: '50%',
      background: 'rgba(0, 0, 0, 0.75)', color: '#fff', fontSize: '16px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', zIndex: '2147483647', userSelect: 'none',
      boxShadow: '0 2px 10px rgba(0,0,0,0.4)', transition: 'all 0.2s ease', opacity: '0.8',
    });
    const tip = document.createElement('div');
    tip.id = '__ca_content_tip__';
    tip.textContent = `${m.label}（内容对齐）`;
    Object.assign(tip.style, {
      position: 'absolute', bottom: '100%', right: '0', marginBottom: '8px',
      padding: '4px 8px', borderRadius: '4px', background: 'rgba(0, 0, 0, 0.85)',
      color: '#fff', fontSize: '11px', whiteSpace: 'nowrap',
      pointerEvents: 'none', opacity: '0', transition: 'opacity 0.15s ease',
    });
    btn.appendChild(tip);

    // 阅读辅助入口
    const readBtn = document.createElement('div');
    readBtn.id = '__ca_read_btn__';
    readBtn.innerHTML = `<span id="__ca_read_icon__">📖</span>`;
    Object.assign(readBtn.style, {
      position: 'fixed', bottom: '62px', right: '0',
      width: '32px', height: '32px', borderRadius: '50%',
      background: 'rgba(0, 0, 0, 0.65)', color: '#fff', fontSize: '13px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', zIndex: '2147483647', userSelect: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)', transition: 'all 0.2s ease',
      opacity: '0', pointerEvents: 'none',
    });
    const readTip = document.createElement('div');
    readTip.id = '__ca_read_tip__';
    readTip.textContent = '阅读辅助';
    Object.assign(readTip.style, {
      position: 'absolute', bottom: '100%', right: '0', marginBottom: '8px',
      padding: '4px 8px', borderRadius: '4px', background: 'rgba(0, 0, 0, 0.85)',
      color: '#fff', fontSize: '11px', whiteSpace: 'nowrap',
      pointerEvents: 'none', opacity: '0', transition: 'opacity 0.15s ease',
    });
    readBtn.appendChild(readTip);

    let hideTimer = null;
    btn.addEventListener('mouseenter', () => {
      btn.style.opacity = '1'; tip.style.opacity = '1';
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      readBtn.style.opacity = '0.8'; readBtn.style.pointerEvents = 'auto';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.opacity = '0.8'; tip.style.opacity = '0';
      hideTimer = setTimeout(() => {
        if (!readMenuOpen) { readBtn.style.opacity = '0'; readBtn.style.pointerEvents = 'none'; }
      }, 300);
    });
    readBtn.addEventListener('mouseenter', () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      readBtn.style.opacity = '1'; readTip.style.opacity = '1';
    });
    readBtn.addEventListener('mouseleave', () => {
      readTip.style.opacity = '0';
      if (!readMenuOpen) {
        hideTimer = setTimeout(() => { readBtn.style.opacity = '0'; readBtn.style.pointerEvents = 'none'; }, 300);
      }
    });
    btn.addEventListener('click', (e) => { e.stopPropagation(); closeReadMenu(); contentMenuOpen ? closeContentMenu() : openContentMenu(); });
    readBtn.addEventListener('click', (e) => { e.stopPropagation(); closeContentMenu(); readMenuOpen ? closeReadMenu() : openReadMenu(); });

    mountPoint().appendChild(btn);
    mountPoint().appendChild(readBtn);
  }

  function updateContentButton() {
    const m = CONTENT_MAP[contentMode] || CONTENT_MAP.original;
    const icon = document.getElementById('__ca_content_icon__');
    const tip = document.getElementById('__ca_content_tip__');
    if (icon) icon.textContent = m.icon;
    if (tip) tip.textContent = `${m.label}（内容对齐）`;
  }

  function updateReadButton() {
    const icon = document.getElementById('__ca_read_icon__');
    const tip = document.getElementById('__ca_read_tip__');
    if (!icon) return;
    if (readActive.size === 0) {
      icon.textContent = '📖';
      tip.textContent = '阅读辅助';
      icon.parentElement.style.background = 'rgba(0, 0, 0, 0.65)';
    } else {
      icon.textContent = '📖';
      // Show count badge via box-shadow trick
      const count = readActive.size;
      const labels = [...readActive].map(m => READ_MAP[m]?.label || m).join(' + ');
      tip.textContent = `已开启 ${count} 项: ${labels}`;
      icon.parentElement.style.background = 'rgba(79, 195, 247, 0.85)';
      // Add count badge
      let badge = icon.parentElement.querySelector('.__ca_badge__');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = '__ca_badge__';
        badge.style.cssText = 'position:absolute;top:-4px;right:-4px;background:#ff5252;color:#fff;font-size:9px;min-width:14px;height:14px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:bold;line-height:1;';
        icon.parentElement.appendChild(badge);

      }
      badge.textContent = count;
    }
  }

  function openContentMenu() {
    if (contentMenuOpen) return;
    contentMenuOpen = true; closeReadMenu();
    const old = document.getElementById('__ca_content_menu__');
    if (old) old.remove();
    const menu = document.createElement('div');
    menu.id = '__ca_content_menu__';
    Object.assign(menu.style, {
      position: 'fixed', bottom: '70px', right: '0',
      background: 'rgba(20, 20, 20, 0.95)', borderRadius: '10px',
      padding: '6px 0', boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
      zIndex: '2147483647', minWidth: '180px',
    });
    buildMenuItems(menu, CONTENT_MODES, contentMode, (id) => { closeContentMenu(); applyContentMode(id); });
    mountPoint().appendChild(menu);
    setTimeout(() => { document.addEventListener('click', closeAllOutside, { once: true, capture: true }); }, 10);
  }

  function closeContentMenu() {
    const m = document.getElementById('__ca_content_menu__');
    if (m) m.remove(); contentMenuOpen = false;
  }

  let bionicConfigOpen = false;

  function openBionicConfig() {
    const old = document.getElementById('__ca_bionic_config__');
    if (old) { old.remove(); bionicConfigOpen = false; return; }
    bionicConfigOpen = true;
    const savedCfg = getBionicConfig();
    // Working copy — only saved on Apply
    const cfg = { ...savedCfg };

    const panel = document.createElement('div'); panel.id = '__ca_bionic_config__';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '140px', right: '0',
      background: 'rgba(30, 30, 30, 0.97)', borderRadius: '10px',
      padding: '10px 14px', boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
      zIndex: '2147483647', width: '200px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    // Title bar
    const title = document.createElement('div');
    title.textContent = '⚙ 仿生阅读设置';
    title.style.cssText = 'color:#4fc3f7;font-size:12px;font-weight:bold;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.1);';
    panel.appendChild(title);

    function addRow(label, options, value) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:5px 0;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = 'color:#ccc;font-size:11px;';
      row.appendChild(lbl);
      const sel = document.createElement('select');
      sel.style.cssText = 'background:#444;color:#fff;border:1px solid #666;border-radius:4px;padding:2px 4px;font-size:11px;cursor:pointer;width:90px;';
      for (const [val, text] of options) {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = text;
        if (val == value) opt.selected = true;
        sel.appendChild(opt);
      }
      row.appendChild(sel);
      return { row, sel };
    }

    function addToggle(label, value) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:5px 0;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = 'color:#ccc;font-size:11px;';
      row.appendChild(lbl);
      const toggle = document.createElement('div');
      toggle.style.cssText = `width:32px;height:18px;border-radius:9px;cursor:pointer;transition:background 0.2s;position:relative;background:${value ? '#4fc3f7' : '#666'};`;
      const knob = document.createElement('div');
      knob.style.cssText = `width:14px;height:14px;border-radius:50%;background:#fff;position:absolute;top:2px;transition:left 0.2s;left:${value ? '16px' : '2px'};`;
      toggle.appendChild(knob);
      row.appendChild(toggle);
      return { row, toggle, knob, update: (v) => { toggle.style.background = v ? '#4fc3f7' : '#666'; knob.style.left = v ? '16px' : '2px'; } };
    }

    // Fixation
    const fixation = addRow('加粗比例', [
      ['0.3', '30%'], ['0.5', '50%'], ['0.7', '70%'], ['1', '100%'],
    ], cfg.fixation);
    fixation.sel.addEventListener('change', () => { cfg.fixation = parseFloat(fixation.sel.value); });
    panel.appendChild(fixation.row);

    // Saccades
    const saccades = addRow('跳词间隔', [
      ['0', '不跳'], ['1', '隔1'], ['2', '隔2'], ['3', '隔3'],
    ], cfg.saccades);
    saccades.sel.addEventListener('change', () => { cfg.saccades = parseInt(saccades.sel.value); });
    panel.appendChild(saccades.row);

    // Fade
    const fade = addToggle('非加粗渐隐', cfg.fade);
    fade.toggle.addEventListener('click', () => { cfg.fade = !cfg.fade; fade.update(cfg.fade); });
    panel.appendChild(fade.row);

    // Apply + Cancel buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.1);';

    const applyBtn = document.createElement('button');
    applyBtn.textContent = '✓ 应用';
    applyBtn.style.cssText = 'flex:1;padding:5px 0;border:none;border-radius:5px;background:#4fc3f7;color:#fff;font-size:11px;font-weight:bold;cursor:pointer;transition:background 0.15s;';
    applyBtn.addEventListener('mouseenter', () => { applyBtn.style.background = '#39b0e7'; });
    applyBtn.addEventListener('mouseleave', () => { applyBtn.style.background = '#4fc3f7'; });
    applyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveBionicConfig(cfg);
      if (readActive.has('bionic')) { disableReadMode('bionic'); applyBionic(); rebuildReadStyle(); }
      panel.remove(); bionicConfigOpen = false;
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕ 取消';
    cancelBtn.style.cssText = 'flex:1;padding:5px 0;border:none;border-radius:5px;background:#555;color:#ccc;font-size:11px;cursor:pointer;transition:background 0.15s;';
    cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = '#666'; });
    cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = '#555'; });
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.remove(); bionicConfigOpen = false;
    });

    btnRow.appendChild(applyBtn);
    btnRow.appendChild(cancelBtn);
    panel.appendChild(btnRow);

    mountPoint().appendChild(panel);
  }
  function openReadMenu() {
    if (readMenuOpen) return;
    readMenuOpen = true; bionicConfigOpen = false; closeContentMenu();
    const old = document.getElementById('__ca_read_menu__');
    if (old) old.remove();
    const menu = document.createElement('div');
    menu.id = '__ca_read_menu__';
    Object.assign(menu.style, {
      position: 'fixed', bottom: '100px', right: '0',
      background: 'rgba(20, 20, 20, 0.95)', borderRadius: '10px',
      padding: '6px 0', boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
      zIndex: '2147483647', minWidth: '200px',
    });
    // 关闭全部按钮
    const closeAll = document.createElement('div');
    closeAll.textContent = '📖 关闭全部';
    Object.assign(closeAll.style, {
      padding: '8px 14px', cursor: 'pointer', color: '#ff8a65',
      fontSize: '13px', fontWeight: 'bold', borderRadius: '6px', margin: '0 4px 4px',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
    });
    closeAll.addEventListener('mouseenter', () => { closeAll.style.background = 'rgba(255,255,255,0.1)'; });
    closeAll.addEventListener('mouseleave', () => { closeAll.style.background = ''; });
    closeAll.addEventListener('click', (e) => { e.stopPropagation(); closeReadMenu(); toggleReadMode('read-off'); });
    menu.appendChild(closeAll);

    // 各模式（可叠加，用 checkbox 风格）
    for (const m of READ_MODES.filter(m => m.id !== 'read-off')) {
      const item = document.createElement('div');
      const active = readActive.has(m.id);
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;padding:8px 14px;cursor:pointer;color:${active ? '#4fc3f7' : '#fff'};font-size:13px;font-weight:${active ? 'bold' : 'normal'};transition:background 0.1s ease;border-radius:6px;margin:0 4px;`;
      const labelSpan = document.createElement('span');
      labelSpan.textContent = `${active ? '☑' : '☐'} ${m.icon} ${m.label}`;
      labelSpan.style.flex = '1';
      row.appendChild(labelSpan);

      // 仿生阅读设置按钮
      if (m.id === 'bionic') {
        const cfgBtn = document.createElement('span');
        cfgBtn.textContent = '⚙';
        cfgBtn.style.cssText = 'font-size:12px;opacity:0.5;padding:2px 6px;border-radius:4px;transition:all 0.15s;';
        cfgBtn.addEventListener('mouseenter', (e) => { e.stopPropagation(); cfgBtn.style.opacity = '1'; cfgBtn.style.background = 'rgba(255,255,255,0.1)'; });
        cfgBtn.addEventListener('mouseleave', (e) => { e.stopPropagation(); cfgBtn.style.opacity = '0.5'; cfgBtn.style.background = ''; });
        cfgBtn.addEventListener('click', (e) => { e.stopPropagation(); openBionicConfig(row); });
        row.appendChild(cfgBtn);
      }

      const desc = document.createElement('div');
      desc.textContent = m.desc;
      Object.assign(desc.style, {
        padding: '0 14px 4px 14px', fontSize: '10px', color: '#888', lineHeight: '1.2',
      });
      row.addEventListener('mouseenter', () => { if (!active) row.style.background = 'rgba(255,255,255,0.1)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.addEventListener('click', (e) => { e.stopPropagation(); toggleReadMode(m.id); closeReadMenu(); openReadMenu(); });
      item.appendChild(row); item.appendChild(desc);
      menu.appendChild(item);
    }
    mountPoint().appendChild(menu);
    setTimeout(() => { document.addEventListener('click', closeAllOutside, { once: true, capture: true }); }, 10);
  }

  function closeReadMenu() {
    const m = document.getElementById('__ca_read_menu__');
    if (m) m.remove(); readMenuOpen = false;
    const readBtn = document.getElementById('__ca_read_btn__');
    if (readBtn && readActive.size === 0) {
      readBtn.style.opacity = '0'; readBtn.style.pointerEvents = 'none';
    }
  }

  function closeBionicConfig() {
    const p = document.getElementById('__ca_bionic_config__');
    if (p) p.remove(); bionicConfigOpen = false;
  }

  function closeAllOutside(e) {
    const ids = ['__ca_content_menu__', '__ca_read_menu__', '__ca_content_btn__', '__ca_read_btn__', '__ca_bionic_config__'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.contains(e.target)) return;
    }
    closeContentMenu(); closeReadMenu(); closeBionicConfig();
  }

  function buildMenuItems(menu, modes, activeId, onSelect) {
    for (const m of modes) {
      const item = document.createElement('div');
      const active = m.id === activeId;
      const row = document.createElement('div');
      row.textContent = `${m.icon} ${m.label}`;
      Object.assign(row.style, {
        padding: '8px 14px', cursor: 'pointer',
        color: active ? '#4fc3f7' : '#fff',
        fontSize: '13px', fontWeight: active ? 'bold' : 'normal',
        transition: 'background 0.1s ease', borderRadius: '6px', margin: '0 4px',
      });
      const desc = document.createElement('div');
      desc.textContent = m.desc;
      Object.assign(desc.style, {
        padding: '0 14px 4px 14px', fontSize: '10px', color: '#888', lineHeight: '1.2',
      });
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.1)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.addEventListener('click', (e) => { e.stopPropagation(); onSelect(m.id); });
      item.appendChild(row); item.appendChild(desc);
      menu.appendChild(item);
    }
  }

  if (typeof GM_registerMenuCommand !== 'undefined') {
    GM_registerMenuCommand('── 内容对齐 ──', () => {});
    for (const m of CONTENT_MODES) GM_registerMenuCommand(`${m.icon} ${m.label}`, () => applyContentMode(m.id));
    GM_registerMenuCommand('── 阅读辅助 ──', () => {});
    for (const m of READ_MODES) GM_registerMenuCommand(`${m.icon} ${m.label}`, () => toggleReadMode(m.id));
  }

  function init() {
    const p = getPrefs();
    if (p.content && CONTENT_MAP[p.content]) contentMode = p.content;
    if (Array.isArray(p.read)) readActive = new Set(p.read);

    createContentButton();
    if (contentMode !== 'original') applyContentMode(contentMode);
    // 恢复阅读辅助
    for (const mode of readActive) {
      if (mode === 'bionic') applyBionic();
      else if (mode === 'ruler') applyRuler();
      else if (mode === 'zebra') applyZebra();
      else if (mode === 'calm-bg') applyCalmBg();
    }
    rebuildReadStyle();
    updateReadButton();

    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => {
          cleanupContent(); cleanupAllRead();
          const p2 = getPrefs();
          if ((p2.content || 'original') !== 'original') applyContentMode(p2.content);
          if (Array.isArray(p2.read)) {
            readActive = new Set(p2.read);
            for (const mode of readActive) {
              if (mode === 'bionic') applyBionic();
              else if (mode === 'ruler') applyRuler();
              else if (mode === 'zebra') applyZebra();
              else if (mode === 'calm-bg') applyCalmBg();
            }
            rebuildReadStyle();
          }
          updateContentButton(); updateReadButton();
        }, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);
})();