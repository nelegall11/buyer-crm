'use strict';

// =====================================================================
//  МИНИ-CRM ДЛЯ БАЙЕРОВ — Telegram Mini App
//
//  Как устроено:
//  • state — все данные приложения (заказы, настройки, что сейчас открыто).
//  • render() — рисует текущий экран заново по данным из state.
//  • Кнопки в HTML помечены data-act="имяДействия" — при нажатии
//    вызывается функция с таким именем из объекта ACTIONS.
//  • api('действие', данные) — разговор с сервером. Пока это demo.js,
//    на этапе 2 — Google Apps Script.
// =====================================================================

// Ссылка на веб-приложение Apps Script (адрес таблицы конкретного байера).
// Бот сам добавляет её в ссылку Mini App: ...webapp/?api=https://script.google.com/macros/s/.../exec
// Так один сайт обслуживает всех байеров — у каждого своя таблица.
// Нет ссылки (или в адресе ?demo) — работаем на демо-данных.
const URL_PARAMS = new URLSearchParams(location.search);
const API_URL = URL_PARAMS.get('api') || '';
const DEMO = !API_URL || URL_PARAMS.has('demo');

const tg = window.Telegram && window.Telegram.WebApp;
const IN_TG = !!(tg && tg.initData); // true — приложение открыто внутри Telegram

// Номера статусов. Названия приходят с сервера (их можно переименовать), а код опирается на порядок.
const S = { WAIT: 0, PAID: 1, BOUGHT: 2, STOCK: 3, WAY: 4, ARRIVED: 5, DONE: 6, CANCEL: 7 };
// Красный не используем: он только для долгов. «Ждёт оплаты» — спокойный серо-синий.
const STATUS_COLORS = ['#9a9aa2', '#d1a03c', '#d9804a', '#9b85cf', '#4f8fcf', '#3aa199', '#3f9a66', '#c4c4c8'];
const TEXT_KEYS = [null, 'paid', 'bought', 'stock', 'way', 'arrived', 'done', null];
const TAB_TITLES = { today: 'Сегодня', orders: 'Заказы', new: 'Новый заказ', clients: 'Клиенты', biz: 'Бизнес' };
const DRAFT_KEY = 'buyercrm-draft';
const PAGE = 30; // по сколько заказов показывать в списке

const state = {
  settings: {}, statuses: [], texts: {}, orders: [],
  tab: 'today',
  cquery: '',         // поиск во вкладке «Клиенты»
  analytics: null,    // вкладка «Бизнес»: короткие строки по всем заказам, включая архив
  bizPeriod: 'month', bizMetric: 'total', bizTable: false, bizSel: null,
  stack: [],          // экраны поверх вкладок: заказ, сводка, готовый заказ
  filter: 'active',   // фильтр списка заказов: 'active', 'all' или номер статуса
  query: '',
  mode: 'orders',     // список «по заказам» или «по клиентам»
  limit: PAGE,        // сколько строк списка показано (остальные — кнопкой «Показать ещё»)
  clients: [],        // все клиенты из таблицы (для подсказок), включая тех, чьи заказы в архиве
  archived: 0,        // сколько старых выданных заказов не загружено
  monthArchived: null,
  selecting: false,   // режим «выбрать несколько заказов»
  selected: [],
  draft: null,        // черновик нового заказа
  justBought: [],     // заказы, которые только что выкупили — пока не убираем их с экрана «Выкупить»
  sheet: null,        // что сейчас открыто в нижней панели
  loading: true,
  error: null,
  busy: false,
};

const $ = sel => document.querySelector(sel);

// =====================================================================
//  ЗАПУСК
// =====================================================================

// Оформление выбирается на этом телефоне (⚙️ Настройки → Оформление) и хранится в нём же
const PALETTES = [
  ['petrol', 'Петроль', '#1f6f78'], ['graphite', 'Графит', '#1f1f1f'], ['sage', 'Шалфей', '#5b7a5a'],
  ['rose', 'Пыльная роза', '#b06a72'], ['indigo', 'Индиго', '#4a56c4'], ['sand', 'Песок', '#a8743a'],
];
const LOOK_KEY = 'buyercrm-look';

function getLook() {
  try { return Object.assign({ palette: 'petrol', density: 'cozy' }, JSON.parse(localStorage.getItem(LOOK_KEY)) || {}); }
  catch (e) { return { palette: 'petrol', density: 'cozy' }; }
}

function setLook(patch) {
  const look = Object.assign(getLook(), patch);
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch (e) { /* не запомнится — не страшно */ }
  applyTheme();
}

// Светлая или тёмная тема — как в Telegram (в браузере — как в системе)
function applyTheme() {
  const look = getLook();
  document.documentElement.dataset.palette = look.palette;
  document.documentElement.dataset.density = look.density;
  const dark = IN_TG && tg.colorScheme ? tg.colorScheme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (IN_TG) {
    const css = getComputedStyle(document.documentElement);
    const page = css.getPropertyValue('--bg2').trim();
    try { tg.setHeaderColor(page); tg.setBackgroundColor(page); } catch (e) { /* старые версии Telegram */ }
    try { tg.setBottomBarColor && tg.setBottomBarColor(css.getPropertyValue('--bg').trim()); } catch (e) { /* нет — не страшно */ }
    try { tg.MainButton.setParams({ color: css.getPropertyValue('--btn').trim(), text_color: css.getPropertyValue('--btn-text').trim() || '#ffffff' }); } catch (e) { /* старые версии */ }
  }
}

function start() {
  applyTheme();
  if (tg && tg.onEvent) tg.onEvent('themeChanged', applyTheme);
  if (!IN_TG) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  if (tg) {
    tg.ready();
    tg.expand();
    if (IN_TG) {
      document.body.classList.add('in-tg');
      tg.MainButton.onClick(onMainButton);
      tg.BackButton.onClick(goBack);
    }
  }
  $('#demoBadge').hidden = !DEMO;
  $('#mainBtn').addEventListener('click', onMainButton);
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  // Вернулись в приложение спустя 5+ минут — тихо обновляем данные
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && lastLoad && Date.now() - lastLoad > 5 * 60000 && !syncPending) loadData();
  });
  loadData();
}

// Данные с прошлого открытия хранятся на телефоне — приложение открывается мгновенно,
// а свежие данные из таблицы подгружаются в фоне
const CACHE_KEY = 'buyercrm-cache:' + API_URL;
let lastLoad = 0;

function saveCache() {
  if (DEMO) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      at: Date.now(),
      d: {
        settings: state.settings, statuses: state.statuses, texts: state.texts, defaultTexts: state.defaultTexts, orders: state.orders,
        clients: state.clients, archived: state.archived, monthArchived: state.monthArchived,
        notes: state.notes, reminders: state.reminders,
      },
    }));
  } catch (e) { /* хранилище недоступно или переполнено — не страшно */ }
}

let cacheTimer = null;
function saveCacheSoon() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(saveCache, 500);
}

function loadCache() {
  if (DEMO) return null;
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    return c && c.d && Array.isArray(c.d.orders) ? c : null;
  } catch (e) { return null; }
}

function applyAll(d) {
  state.settings = d.settings;
  state.statuses = d.statuses;
  state.texts = d.texts;
  state.defaultTexts = d.defaultTexts || state.defaultTexts || d.texts;
  applyInit(d);
  if (!state.draft) state.draft = loadDraft() || newDraft();
}

async function loadData() {
  const cached = state.orders.length ? null : loadCache();
  if (cached) {
    applyAll(cached.d);
    state.loading = false;
    state.refreshing = true;
  } else if (!state.orders.length) {
    state.loading = true;
  } else {
    state.refreshing = true;
  }
  state.error = null;
  updateSyncBadge();
  render();

  try {
    const d = await api('init');
    if (syncPending) {
      // Пока грузили, байер что-то поменял — не затираем, просто дождёмся следующего обновления
    } else {
      applyAll(d);
      saveCache();
    }
    lastLoad = Date.now();
    const deep = Number(URL_PARAMS.get('order'));
    if (deep && !state.deepOpened && findOrder(deep)) { state.deepOpened = true; openScreen({ type: 'order', no: deep }); }
  } catch (err) {
    const denied = err.code === 'auth' || err.code === 'forbidden';
    if (state.orders.length && !denied) {
      toast('Нет связи — показаны данные с прошлого раза', true);
    } else {
      state.error = err.message || String(err);
      state.errorCode = err.code || (err instanceof TypeError ? 'network' : '');
      if (denied) { state.orders = []; try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* ничего */ } }
    }
  }
  state.loading = false;
  state.refreshing = false;
  updateSyncBadge();
  if (state.error) render(); else softRender();
}

function applyInit(d) {
  state.orders = d.orders;
  state.clients = d.clients || [];
  state.archived = d.archived || 0;
  state.monthArchived = d.monthArchived || null;
  state.notes = d.notes || {};
  state.reminders = d.reminders || [];
  // Запоминаем, что загрузили при открытии: заказы, найденные потом в архиве, не считаем в сводке дважды
  state.baseNos = new Set(d.orders.map(o => o.no));
  state.maxNo = d.orders.reduce((m, o) => Math.max(m, o.no), 0);
}

// Заказ уже учтён в итогах сервера? (новые после открытия — нет)
function isFresh(o) { return o.no > state.maxNo; }
// Заказ надо считать в сводке? (загружен при открытии или создан после; найденные в архиве — нет)
function inSummary(o) { return state.baseNos.has(o.no) || isFresh(o); }

// =====================================================================
//  СЕРВЕР
// =====================================================================

async function api(action, data = {}) {
  if (DEMO) return DemoServer.handle(action, data);
  // Content-Type text/plain — чтобы браузер не делал лишний запрос OPTIONS, который Apps Script не понимает
  // ?api=1 — чтобы скрипт понял, что это Mini App, а не сообщение боту
  const res = await fetch(API_URL + (API_URL.includes('?') ? '&' : '?') + 'api=1', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, initData: tg ? tg.initData : '', ...data }),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    // Вместо JSON пришла страница Google — обычно ошибка в скрипте или неверный доступ к развёртыванию
    throw new Error('Таблица ответила не так, как ожидалось. Проверьте развёртывание скрипта (доступ: «Все»)');
  }
  if (!json.ok) {
    const err = new Error(json.error || 'Ошибка сервера');
    err.code = json.code;
    throw err;
  }
  return json.data;
}

// Вызов сервера с защитой от двойного нажатия и понятной ошибкой
async function call(action, data) {
  if (state.busy) return null;
  state.busy = true;
  document.body.classList.add('busy');
  try {
    const res = await api(action, data);
    if (res && res.orders) mergeOrders(res.orders);
    if (res && res.settings) state.settings = res.settings;
    saveCacheSoon();
    return res;
  } catch (err) {
    console.error(err);
    const msg = err instanceof TypeError ? 'Нет связи, попробуйте ещё раз' : (err.message || 'Ошибка');
    toast(msg, true);
    haptic('error');
    return null;
  } finally {
    state.busy = false;
    document.body.classList.remove('busy');
  }
}

function mergeOrders(list) {
  list.forEach(o => {
    const i = state.orders.findIndex(x => x.no === o.no);
    if (i >= 0) state.orders[i] = o; else state.orders.push(o);
  });
}

// =====================================================================
//  МГНОВЕННЫЙ ОТКЛИК
//  Изменение сразу видно на экране, а в таблицу уходит в фоне — строго по очереди.
//  Если сохранить не удалось — возвращаем заказ как было и показываем ошибку.
// =====================================================================

let syncQueue = Promise.resolve();
let syncPending = 0;

// apply(o) меняет заказ на телефоне; action/data — что отправить в таблицу. Возвращает «как было» (для «Отменить»).
function mutate(nos, apply, action, data) {
  const before = snapshot(nos);
  nos.forEach(no => { const o = findOrder(no); if (o) apply(o); });
  saveCacheSoon();
  syncPending++;
  updateSyncBadge();
  syncQueue = syncQueue.then(async () => {
    try {
      const res = await api(action, data);
      if (res && res.orders) mergeOrders(res.orders);
    } catch (err) {
      console.error(err);
      mergeOrders(before);
      const msg = err instanceof TypeError ? 'нет связи' : (err.message || 'ошибка');
      toast(`Не сохранилось (${msg}). Вернули как было`, true);
      haptic('error');
    } finally {
      syncPending--;
      updateSyncBadge();
      saveCacheSoon();
      softRender();
    }
  });
  return before;
}

// Перерисовать экран, но не мешать, если байер сейчас что-то печатает
function softRender() {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && $('#view').contains(a)) return;
  render();
}

// Значок «сохраняю…» в шапке. Пока есть несохранённое, Telegram спросит перед закрытием.
function updateSyncBadge() {
  const b = $('#syncBadge');
  if (b) {
    b.hidden = !syncPending && !state.refreshing;
    b.querySelector('span').textContent = syncPending ? 'сохраняю' : 'обновляю';
  }
  if (IN_TG && tg.isVersionAtLeast && tg.isVersionAtLeast('6.2')) {
    if (syncPending) tg.enableClosingConfirmation(); else tg.disableClosingConfirmation();
  }
}

// Те же правила, что в таблице: смена статуса запоминает время, «Выкуплен» отмечает все товары
function setLocalStatus(o, i, track) {
  const status = state.statuses[i];
  if (o.status !== status) o.statusAt = new Date().toISOString();
  o.status = status;
  if (track) o.track = track;
  if (i === S.BOUGHT) o.items.forEach(x => { x.bought = true; });
}

// =====================================================================
//  ОТРИСОВКА
// =====================================================================

function render() {
  const top = state.stack[state.stack.length - 1];
  const view = $('#view');

  if (state.loading) view.innerHTML = loadingHtml();
  else if (state.error) view.innerHTML = errorHtml();
  else view.innerHTML = top ? SCREENS[top.type](top) : TABS[state.tab]();

  document.body.classList.toggle('overlay', !!top);
  $('#title').textContent = top ? screenTitle(top) : TAB_TITLES[state.tab];
  $('#backBtn').hidden = IN_TG || !top;
  $('#setBtn').hidden = !!top || state.loading || !!state.error;

  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (!state.loading && !state.error) {
    const n = attentionItems().length;
    $('#cntToday').textContent = n || '';
  }

  updateMainButton();
  if (IN_TG) { if (top) tg.BackButton.show(); else tg.BackButton.hide(); }
}

function screenTitle(top) {
  if (top.type === 'order') return `Заказ №${top.no}`;
  if (top.type === 'summary') return 'Сводка';
  if (top.type === 'done') return 'Готово';
  if (top.type === 'buy') return 'Выкупить';
  if (top.type === 'debts') return 'Долги';
  if (top.type === 'attention') return 'Требует внимания';
  if (top.type === 'parcel') return 'Пришла посылка';
  if (top.type === 'handoverList') return 'Выдать';
  if (top.type === 'handover') return 'Выдача';
  if (top.type === 'calc') return 'Сколько стоит?';
  if (top.type === 'settings') return 'Настройки';
  if (top.type === 'client') {
    const o = state.orders.find(x => clientKey(x) === top.key);
    return o ? o.client : 'Клиент';
  }
  return '';
}

// Пока данные грузятся — серые «заготовки» плиток и строк, как в больших приложениях
function loadingHtml() {
  const row = '<div class="lrow"><div class="grow"><div class="sk" style="width:55%"></div><div class="sk sm" style="width:35%"></div></div><div class="sk" style="width:70px"></div></div>';
  return `<div class="tiles">${'<div class="tile sk-tile"><div class="sk sm" style="width:50%"></div><div class="sk lg" style="width:70%"></div></div>'.repeat(4)}</div>
    <div class="list">${row.repeat(5)}</div>`;
}

function errorHtml() {
  // Нет доступа (не тот Telegram ID или открыто не из Telegram) — повтор не поможет, показываем причину
  if (state.errorCode === 'auth' || state.errorCode === 'forbidden') {
    return `<div class="empty"><span class="e-icon">${icon('lock')}</span><b>Нет доступа</b>${esc(state.error)}</div>`;
  }
  const network = state.errorCode === 'network';
  return `<div class="empty"><span class="e-icon">${icon('offline')}</span>
    <b>${network ? 'Нет связи' : 'Не получилось загрузить'}</b>${network ? 'Проверьте интернет и попробуйте ещё раз' : esc(state.error)}<br><br>
    <button class="btn primary" data-act="retry">Повторить</button></div>`;
}

const EMPTY_ICONS = { '📭': 'inbox', '🤷': 'search', '🎉': 'check', '✅': 'check', '📡': 'offline' };

function emptyHtml(sym, title, text = '') {
  return `<div class="empty"><span class="e-icon">${icon(EMPTY_ICONS[sym] || 'inbox')}</span><b>${title}</b>${text}</div>`;
}

// ---------- Главная кнопка ----------
// Внутри Telegram это родная кнопка внизу экрана (MainButton), в браузере — наша #mainBtn.

let mainAction = null;

function updateMainButton() {
  const top = state.stack[state.stack.length - 1];
  let text = null;
  mainAction = null;

  if (!state.loading && !state.error && top && top.type === 'settings' && top.dirty) {
    text = 'Сохранить настройки';
    mainAction = saveSettings;
  }
  if (!state.loading && !state.error && top && top.type === 'handover') {
    const n = handoverSel(top).length;
    if (n) { text = `Выдать ${ordersWord(n)}`; mainAction = applyHandover; }
  }
  if (!state.loading && !state.error && top && top.type === 'parcel' && top.track) {
    const n = top.sel.length;
    if (n) { text = `Отметить «${state.statuses[S.ARRIVED]}» (${n})`; mainAction = applyParcel; }
  }
  if (!state.loading && !state.error && !top) {
    if (state.tab === 'new') {
      const c = calcDraft();
      text = c.total > 0 ? `Сохранить заказ · ${money(c.total)}` : 'Сохранить заказ';
      mainAction = saveOrder;
    } else if (state.tab === 'orders' && state.selecting && state.selected.length) {
      text = `Сменить статус (${state.selected.length})`;
      mainAction = openBulkStatusSheet;
    }
  }
  if (state.sheet) { text = null; mainAction = null; }

  if (IN_TG) {
    if (text) { tg.MainButton.setText(text); tg.MainButton.show(); } else tg.MainButton.hide();
  } else {
    const b = $('#mainBtn');
    b.hidden = !text;
    if (text) b.textContent = text;
  }
}

function onMainButton() {
  if (mainAction && !state.busy) mainAction();
}

function setMainProgress(on) {
  if (IN_TG) { if (on) tg.MainButton.showProgress(); else tg.MainButton.hideProgress(); }
  else $('#mainBtn').disabled = on;
}

// =====================================================================
//  НАВИГАЦИЯ
// =====================================================================

function openScreen(screen) {
  closeSheet(false);
  state.stack.push(screen);
  render();
  animateView('in');
  window.scrollTo(0, 0);
}

function goBack() {
  if (state.sheet) return closeSheet();
  const top = currentScreen();
  if (top && top.type === 'settings' && top.dirty && !confirm('Выйти без сохранения?')) return;
  state.stack.pop();
  render();
  animateView('back');
}

// Короткая анимация смены экрана: вперёд — въезд справа, назад — слева, вкладки — проявление
function animateView(kind) {
  const v = $('#view');
  v.classList.remove('anim-in', 'anim-back', 'anim-fade');
  void v.offsetWidth; // перезапуск анимации
  v.classList.add('anim-' + kind);
}

function switchTab(tab) {
  closeSheet(false);
  state.stack = [];
  if (tab !== state.tab) {
    state.selecting = false;
    state.selected = [];
    state.justBought = [];
  }
  state.tab = tab;
  render();
  animateView('fade');
  window.scrollTo(0, 0);
}

// =====================================================================
//  НАЖАТИЯ И ВВОД
// =====================================================================

function onClick(e) {
  // Клик мимо подсказок клиентов — прячем их
  if (!e.target.closest('.suggest') && !e.target.closest('[data-f="who"]')) {
    document.querySelectorAll('.suggest').forEach(s => { s.innerHTML = ''; });
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) {
    e.preventDefault();
    fn(el.dataset, el);
  }
}

const ACTIONS = {
  tab: d => switchTab(d.tab),
  back: () => goBack(),
  retry: () => loadData(),
  summary: () => openScreen({ type: 'summary' }),
  openOrder: d => openScreen({ type: 'order', no: Number(d.no) }),
  open: d => openLink(d.url),
  sheetClose: () => closeSheet(),

  // Список заказов
  filter: d => { state.filter = ['active', 'all', 'going'].includes(d.v) ? d.v : Number(d.v); state.limit = PAGE; render(); },
  // Плитка: первое нажатие — показать эти заказы, второе — вернуться ко всем в работе
  tile: d => {
    const v = d.v === 'going' ? 'going' : Number(d.v);
    state.filter = state.filter === v && !state.stack.length ? 'active' : v;
    state.mode = 'orders';
    state.stack = [];
    state.tab = 'orders';
    state.limit = PAGE;
    render();
    const list = $('#orderList');
    if (list && state.filter !== 'active') list.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },
  tabDebts: () => openScreen({ type: 'debts' }),

  // Вкладка «Бизнес»
  bizPeriod: d => { state.bizPeriod = d.v; state.bizSel = null; render(); },
  bizMetric: d => { state.bizMetric = d.v; render(); },
  bizBar: d => { state.bizSel = Number(d.i); render(); },
  bizTable: () => { state.bizTable = !state.bizTable; render(); },
  bizRetry: () => { state.analyticsError = null; render(); },
  openSettings: () => {
    const st = state.settings;
    openScreen({
      type: 'settings', dirty: false, open: null,
      form: {
        shopName: st.shopName || '', paymentDetails: st.paymentDetails || '',
        retail: st.retail, opt: st.opt, round: st.round, usd: st.usd, eur: st.eur,
        goal: st.goal || '', taxRate: st.taxRate || 0,
        attention: Object.assign({ wait: 3, paid: 3, way: 25, arrived: 5 }, st.attention || {}),
        texts: Object.assign({}, state.texts),
      },
    });
  },
  lookPalette: d => { setLook({ palette: d.v }); render(); haptic('light'); },
  lookDensity: d => { setLook({ density: d.v }); render(); },
  textOpen: d => { const t = currentScreen(); t.open = t.open === d.k ? null : d.k; render(); },
  textReset: d => {
    const t = currentScreen();
    t.form.texts[d.k] = (state.defaultTexts || {})[d.k] || '';
    t.dirty = true;
    render();
  },
  settingsSave: () => saveSettings(),
  sendDetails: d => {
    const o = findOrder(Number(d.no));
    const url = o && waLink(o.phone, fillText(state.texts.payment || 'Оплатить можно сюда: {details}. Сумма: {debt}', o, { details: state.settings.paymentDetails }));
    if (url) openLink(url);
  },
  openCalc: () => openScreen({ type: 'calc', amount: '', cur: '$', qty: 1, opt: false }),
  calcCur: d => { currentScreen().cur = d.v; render(); },
  calcOpt: d => { currentScreen().opt = d.v === '1'; render(); },
  calcQty: d => { const t = currentScreen(); t.qty = Math.max(1, t.qty + Number(d.v)); render(); },
  calcCopy: () => copyText(calcAnswer()),
  calcOrder: () => {
    const t = currentScreen();
    state.draft = newDraft();
    state.draft.opt = t.opt;
    state.draft.markup = String(t.opt ? state.settings.opt : state.settings.retail);
    state.draft.items[0].amount = String(parseNum(t.amount) || '');
    state.draft.items[0].currency = t.cur;
    state.draft.items[0].qty = String(t.qty);
    saveDraft();
    switchTab('new');
  },
  trackShare: d => shareTrackLink(Number(d.no)),
  noteSheet: d => openNoteSheet(d.key, d.name, d.phone),
  noteSave: d => saveNote(d.key, d.name, d.phone),
  reminderSheet: d => openReminderSheet(d.no ? Number(d.no) : null, d.key || '', d.name || ''),
  reminderWhen: d => {
    document.querySelectorAll('[data-act="reminderWhen"]').forEach(b => b.classList.toggle('on', b.dataset.v === d.v));
    $('#remWhen').value = toLocalInput(new Date(Number(d.v)));
  },
  reminderSave: d => saveReminder(d.no ? Number(d.no) : null, d.key || ''),
  reminderDelete: d => deleteReminder(d.id),
  goalSheet: () => openGoalSheet(),
  goalSave: () => {
    const n = Math.round(parseNum($('#goalInput').value) || 0);
    if (!(n > 0)) { $('#goalInput').classList.add('bad'); $('#goalInput').focus(); return; }
    saveGoal(n);
  },
  goalClear: () => saveGoal(0),
  expenseSheet: () => openExpenseSheet(),
  expenseCat: d => {
    document.querySelectorAll('[data-act="expenseCat"]').forEach(b => b.classList.toggle('on', b.dataset.v === d.v));
    $('[data-act="expenseSave"]').dataset.cat = d.v;
  },
  expenseSave: d => {
    const n = parseNum($('#expAmount').value);
    if (!(n > 0)) { $('#expAmount').classList.add('bad'); $('#expAmount').focus(); return; }
    addExpense(Math.round(n), d.cat, ($('#expNote').value || '').trim());
  },
  expenseDelete: d => deleteExpense(d.id),
  openBuy: () => { state.justBought = []; openScreen({ type: 'buy' }); },
  openAttention: () => openScreen({ type: 'attention' }),
  openHandoverList: () => openScreen({ type: 'handoverList' }),
  newOrderTab: () => switchTab('new'),
  undo: () => doUndo(),

  // «Требует внимания»: написать клиенту и убрать заказ из списка на 2 дня
  attnWrite: d => {
    openLink(d.url);
    const no = Number(d.no);
    mutate([no], o => { o.snoozeUntil = new Date(Date.now() + 2 * 86400000).toISOString(); }, 'snooze', { no, days: 2 });
    render();
  },

  // Пришла посылка
  openParcel: () => openScreen({ type: 'parcel', track: '', sel: [] }),
  parcelFind: () => pickParcel(($('#parcelInput').value || '').trim()),
  parcelPick: d => pickParcel(d.track),
  parcelToggle: d => {
    const top = currentScreen();
    const no = Number(d.no);
    top.sel = top.sel.includes(no) ? top.sel.filter(n => n !== no) : top.sel.concat(no);
    render();
  },
  parcelReset: () => { const top = currentScreen(); top.track = ''; top.sel = []; render(); },

  // Выдача клиенту
  openHandover: d => openScreen({ type: 'handover', key: d.key, sel: null, paid: null }),
  hoToggle: d => {
    const top = currentScreen();
    const no = Number(d.no);
    const sel = handoverSel(top);
    top.sel = sel.includes(no) ? sel.filter(n => n !== no) : sel.concat(no);
    render();
  },
  hoPaid: d => { currentScreen().paid = d.v === '1'; render(); },

  mode: d => { state.mode = d.v; state.limit = PAGE; state.selecting = false; state.selected = []; render(); },
  moreClients: () => { state.limit += PAGE; $('#clientList').innerHTML = clientsListHtml(); },
  more: () => { state.limit += PAGE; $('#orderList').innerHTML = orderListHtml(); },
  selectMode: () => { state.selecting = !state.selecting; state.selected = []; render(); },
  // Выбрать все заказы, которые сейчас видны по фильтру и поиску (или снять выбор)
  selectAll: () => {
    const nos = filteredOrders().map(o => o.no);
    const all = nos.length && nos.every(n => state.selected.includes(n));
    state.selected = all ? [] : nos;
    render();
  },
  openClient: d => openScreen({ type: 'client', key: d.key }),
  newForClient: d => {
    state.draft = newDraft();
    pickDraftClient(d.name, d.phone);
    saveDraft();
    switchTab('new');
  },
  toggleSel: d => {
    const no = Number(d.no);
    state.selected = state.selected.includes(no) ? state.selected.filter(n => n !== no) : state.selected.concat(no);
    render();
  },

  // Статусы
  setStatus: d => askStatus([Number(d.no)], Number(d.i)),
  statusSheet: d => openStatusSheet(Number(d.no)),
  pickStatus: d => {
    const o = findOrder(Number(d.no));
    if (o && statusIdx(o.status) === Number(d.i)) return closeSheet();
    askStatus([Number(d.no)], Number(d.i));
  },
  bulkPick: d => askStatus(state.selected.slice(), Number(d.i)),
  trackSave: d => applyStatus(JSON.parse(d.nos), Number(d.i), ($('#trackInput').value || '').trim()),
  trackSkip: d => applyStatus(JSON.parse(d.nos), Number(d.i), ''),
  saveTrack: d => {
    const no = Number(d.no);
    const track = ($('#trackEdit').value || '').trim();
    mutate([no], o => { o.track = track; }, 'saveTrack', { no, track });
    toast('Трек-номер сохранён ✅');
    render();
  },

  // Оплата
  payment: d => openPaymentSheet(Number(d.no)),
  payAll: d => {
    const o = findOrder(Number(d.no));
    if (o) addPayment(o.no, o.debt);
  },
  paySubmit: d => {
    const n = parseNum($('#payInput').value);
    if (!(n > 0)) { $('#payInput').classList.add('bad'); $('#payInput').focus(); return; }
    addPayment(Number(d.no), n);
  },

  // Выкупить
  buyToggle: d => {
    const no = Number(d.no);
    const id = Number(d.id);
    const was = statusIdx(findOrder(no).status);
    const bought = !findOrder(no).items.find(x => x.id === id).bought;
    mutate([no], o => {
      o.items.find(x => x.id === id).bought = bought;
      // Все товары отмечены → «Выкуплен»; сняли галочку у выкупленного → снова «Оплачен»
      const i = statusIdx(o.status);
      if (i === S.PAID && o.items.every(x => x.bought)) setLocalStatus(o, S.BOUGHT);
      else if (i === S.BOUGHT && !bought) setLocalStatus(o, S.PAID);
    }, 'setBought', { no, itemId: id, bought });
    haptic('light');
    if (statusIdx(findOrder(no).status) === S.BOUGHT && was !== S.BOUGHT) {
      if (!state.justBought.includes(no)) state.justBought.push(no);
      toast(`Заказ №${no} полностью выкуплен ✅`);
      haptic('success');
    }
    render();
  },

  // Новый заказ
  opt: d => {
    const dr = state.draft;
    dr.opt = d.v === '1';
    if (!dr.markupTouched) dr.markup = String(dr.opt ? state.settings.opt : state.settings.retail);
    saveDraft();
    render();
  },
  addItem: () => {
    state.draft.items.push(newItem());
    saveDraft();
    render();
    const inputs = document.querySelectorAll('[data-f="link"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  },
  delItem: d => {
    state.draft.items.splice(Number(d.i), 1);
    if (!state.draft.items.length) state.draft.items.push(newItem());
    saveDraft();
    render();
  },
  cur: d => { state.draft.items[Number(d.i)].currency = d.v; saveDraft(); render(); },
  qty: d => {
    const it = state.draft.items[Number(d.i)];
    it.qty = String(Math.max(1, (Math.round(parseNum(it.qty)) || 1) + Number(d.v)));
    saveDraft();
    render();
  },
  paid: d => {
    state.draft.paidMode = d.v;
    saveDraft();
    render();
    if (d.v === 'custom') $('[data-f="paidCustom"]').focus();
  },
  pasteToggle: () => { state.draft.pasteOpen = !state.draft.pasteOpen; render(); if (state.draft.pasteOpen) $('[data-f="pasteText"]').focus(); },
  parsePaste: () => applyPaste(),
  restoreFailed: () => {
    // Текущий черновик не теряем: если в нём что-то есть, меняем местами
    const current = state.draft;
    state.draft = state.failedDraft;
    delete state.draft.failed;
    state.failedDraft = isBlankDraft(current) ? null : current;
    saveDraft();
    render();
  },
  dropFailed: () => {
    if (!confirm('Удалить несохранённый заказ?')) return;
    state.failedDraft = null;
    render();
  },
  unpickClient: () => {
    const d = state.draft;
    d.picked = false; d.client = ''; d.phone = ''; d.who = '';
    saveDraft();
    render();
    const el = $('[data-f="who"]');
    if (el) el.focus();
  },
  pickClient: d => {
    pickDraftClient(d.name, d.phone);
    saveDraft();
    render();
  },
  clearDraft: () => {
    if (!confirm('Очистить форму?')) return;
    state.draft = newDraft();
    saveDraft();
    render();
  },
  newOrder: () => { state.draft = newDraft(); saveDraft(); switchTab('new'); },
  doneOpenOrder: d => { state.stack = []; state.tab = 'orders'; openScreen({ type: 'order', no: Number(d.no) }); },

  resetDemo: async () => {
    if (!confirm('Вернуть демо-данные к началу? Всё, что вы добавили, пропадёт.')) return;
    const d = await call('resetDemo');
    if (d) {
      state.analytics = null;
      applyInit(d);
      state.settings = d.settings;
      state.draft = newDraft();
      saveDraft();
      state.stack = [];
      toast('Демо-данные сброшены');
      switchTab('orders');
    }
  },
};

function onInput(e) {
  const el = e.target;
  el.classList.remove('bad');

  if (el.dataset.sf || el.dataset.sa || el.dataset.st) {
    const t = currentScreen();
    if (el.dataset.sf) t.form[el.dataset.sf] = el.value;
    if (el.dataset.sa) t.form.attention[el.dataset.sa] = el.value;
    if (el.dataset.st) {
      t.form.texts[el.dataset.st] = el.value;
      const ex = $('#ex-' + el.dataset.st);
      if (ex) ex.textContent = sampleText(el.value);
    }
    if (!t.dirty) { t.dirty = true; updateMainButton(); }
    return;
  }

  if (el.id === 'calcAmount') {
    currentScreen().amount = el.value;
    $('#calcResult').innerHTML = calcResultHtml();
    $('#calcWa').dataset.url = 'https://wa.me/?text=' + encodeURIComponent(calcAnswer());
    return;
  }

  if (el.id === 'csearch') {
    state.cquery = el.value;
    state.limit = PAGE;
    $('#clientList').innerHTML = clientsListHtml();
    return;
  }

  if (el.id === 'search') {
    state.query = el.value;
    state.limit = PAGE;
    $('#orderList').innerHTML = orderListHtml();
    searchArchive(el.value);
    return;
  }

  const f = el.dataset.f;
  if (!f || !state.draft) return;
  const d = state.draft;
  if (el.dataset.i !== undefined) d.items[Number(el.dataset.i)][f] = el.value;
  else d[f] = el.value;

  if (f === 'markup') d.markupTouched = true;
  if (f === 'who' || f === 'otherName' || f === 'otherPhone') onClientInput(el, f);
  if (f !== 'pasteText') updateTotals();
  saveDraft();
}

// =====================================================================
//  ВКЛАДКИ
// =====================================================================

const TABS = {
  today: todayTab,
  orders: ordersTab,
  new: newOrderTab,
  clients: clientsTab,
  biz: bizTab,
};

function currentScreen() { return state.stack[state.stack.length - 1]; }

// ---------- Заказы ----------

function ordersTab() {
  if (!state.orders.length) {
    return emptyHtml('📭', 'Заказов пока нет', 'Нажмите «Новый» внизу, чтобы добавить первый');
  }
  const counts = state.statuses.map(s => state.orders.filter(o => o.status === s).length);
  const active = state.orders.filter(o => !isClosed(o)).length;
  const chip = (v, label, n) =>
    `<button class="chip ${String(state.filter) === String(v) ? 'on' : ''}" data-act="filter" data-v="${v}">${label}<span class="n">${n}</span></button>`;

  const byClients = state.mode === 'clients';
  const visible = filteredOrders().map(o => o.no);
  const allSel = visible.length && visible.every(n => state.selected.includes(n));
  let toolbar;
  if (byClients) toolbar = `<span class="hint">Клиенты, у которых есть заказы по фильтру</span>`;
  else if (state.selecting) toolbar = `
    <button class="link-btn" data-act="selectAll">${allSel ? 'Снять все' : `Выбрать все (${visible.length})`}</button>
    <button class="link-btn" data-act="selectMode">Отмена</button>`;
  else toolbar = '';
  const modeSeg = state.selecting ? '' : `
    <span class="hint small">${ordersWord(filteredOrders().length)}</span>
    <button class="link-btn" data-act="selectMode">${icon('checks')}Выбрать несколько</button>`;

  return `
    <div class="search-wrap">${icon('search')}
      <input id="search" class="input search" type="search" placeholder="Имя, телефон или № заказа" value="${esc(state.query)}" autocomplete="off">
    </div>
    <div class="toolbar">${state.selecting ? toolbar : modeSeg}</div>
    <div class="chips">
      ${chip('active', 'В работе', active)}
      ${state.statuses.map((s, i) => counts[i] ? chip(i, s, counts[i]) : '').join('')}
      ${chip('all', 'Все', state.orders.length)}
    </div>
    ${byClients && !state.selecting ? `<p class="hint" style="margin:0 4px 8px">${toolbar.replace(/<[^>]+>/g, '')}</p>` : ''}
    <div id="orderList">${orderListHtml()}</div>`;
}

// Статусы «едут»: выкуплен, на складе, в пути
const GOING = [S.BOUGHT, S.STOCK, S.WAY];

function filteredOrders() {
  const q = state.query.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  return state.orders
    .filter(o => {
      if (state.filter === 'active') return !isClosed(o);
      if (state.filter === 'all') return true;
      if (state.filter === 'going') return GOING.includes(statusIdx(o.status));
      return statusIdx(o.status) === state.filter;
    })
    .filter(o => !q ||
      o.client.toLowerCase().includes(q) ||
      String(o.no) === q.replace('№', '') ||
      (digits.length >= 3 && o.phone.replace(/\D/g, '').includes(digits)))
    .sort((a, b) => b.no - a.no);
}

function orderListHtml() {
  const list = filteredOrders();
  const archiveHint = state.archived && (state.filter === 'all' || state.filter === S.DONE || state.filter === S.CANCEL || state.query)
    ? `<p class="hint center">Старые выданные заказы без долга (${state.archived}) не загружаются, чтобы приложение открывалось быстро. Найдите их поиском.</p>` : '';
  if (!list.length) {
    return (state.query ? emptyHtml('🤷', 'Ничего не найдено', 'Попробуйте часть имени или последние 4 цифры телефона')
      : emptyHtml('🎉', 'Здесь пусто', 'В этом статусе заказов нет')) + archiveHint;
  }
  const rows = state.mode === 'clients' ? groupByClient(list) : list;
  const shown = rows.slice(0, state.limit);
  const rest = rows.length - shown.length;
  return `<div class="list">${shown.map(state.mode === 'clients' ? clientRow : orderRow).join('')}</div>` +
    (rest > 0 ? `<button class="btn" data-act="more">Показать ещё ${Math.min(rest, PAGE)} из ${rest}</button>` : '') +
    archiveHint;
}

// Строка заказа в списке: две короткие строки вместо большой карточки
function orderRow(o) {
  const sel = state.selecting;
  const checked = state.selected.includes(o.no);
  const debt = o.debt > 0 && !isCancelled(o);
  const i = statusIdx(o.status);
  return `
    <div class="lrow stripe ${checked ? 'checked' : ''}" style="${statusStyle(i)}" data-act="${sel ? 'toggleSel' : 'openOrder'}" data-no="${o.no}">
      ${sel ? `<span class="check">${checked ? '✓' : ''}</span>` : ''}
      <div class="grow">
        <div class="l1"><span class="name ellipsis">${esc(o.client)}</span></div>
        <div class="l2">№${o.no} · <span class="st">${esc(o.status)}</span> · ${fmtDate(o.date)}</div>
      </div>
      <div class="rt">
        <div class="money">${money(o.total)}</div>
        ${debt ? `<div class="debt money small">долг ${money(o.debt)}</div>` : `<div class="hint small">${o.count} шт</div>`}
      </div>
    </div>`;
}

// ---------- Клиенты ----------

function clientKey(o) {
  return String(o.phone).replace(/\D/g, '').slice(-10) || String(o.client).toLowerCase();
}

// Собирает заказы в клиентов: один клиент — одна строка
function groupByClient(orders) {
  const map = new Map();
  orders.forEach(o => {
    const k = clientKey(o);
    if (!map.has(k)) map.set(k, { key: k, name: o.client, phone: o.phone, orders: [], total: 0, debt: 0, last: 0 });
    const c = map.get(k);
    c.orders.push(o);
    c.total += o.total;
    if (!isCancelled(o)) c.debt += Math.max(0, o.debt);
    if (o.no > c.last) { c.last = o.no; c.name = o.client; c.phone = o.phone; }
  });
  return [...map.values()].sort((a, b) => b.last - a.last);
}

function statusSummary(orders) {
  return state.statuses.map((s, i) => {
    const n = orders.filter(o => o.status === s).length;
    return n ? `<span class="pill sm" style="${statusStyle(i)}">${esc(s)}${n > 1 ? ' · ' + n : ''}</span>` : '';
  }).join('');
}

// Строка клиента: метки только для заказов в работе, чтобы не пестрило
function clientRow(c) {
  const active = c.orders.filter(o => !isClosed(o));
  return `
    <div class="lrow" data-act="openClient" data-key="${esc(c.key)}">
      <span class="ava">${esc(initials(c.name))}</span>
      <div class="grow">
        <div class="l1"><span class="name ellipsis">${esc(c.name)}</span></div>
        ${active.length ? `<div class="pills">${statusSummary(active)}</div>`
          : `<div class="l2">${ordersWord(c.orders.length)} · все завершены</div>`}
      </div>
      <div class="rt">
        ${c.debt > 0 ? `<div class="debt money">${money(c.debt)}</div><div class="hint small">долг</div>` : `<div class="money">${money(c.total)}</div><div class="hint small">${ordersWord(c.orders.length)}</div>`}
      </div>
    </div>`;
}

let clientLoadKey = null;

function clientScreen({ key }) {
  // Подгружаем с сервера и старые заказы клиента (один раз)
  if (clientLoadKey !== key) {
    clientLoadKey = key;
    api('clientOrders', { key }).then(res => {
      mergeOrders(res.orders);
      const top = state.stack[state.stack.length - 1];
      if (top && top.type === 'client' && top.key === key) render();
    }).catch(() => { clientLoadKey = null; });
  }
  const orders = state.orders.filter(o => clientKey(o) === key).sort((a, b) => b.no - a.no);
  if (!orders.length) return emptyHtml('🤷', 'Клиент не найден');
  const c = groupByClient(orders)[0];
  const chat = waLink(c.phone, '');
  const active = orders.filter(o => !isClosed(o));
  const closed = orders.filter(o => isClosed(o));

  return `
    <div class="card">
      <div class="row">
        <span class="ava big">${esc(initials(c.name))}</span>
        <div class="grow">
          <b class="ellipsis" style="display:block;font-size:18px">${esc(c.name)}</b>
          <div class="hint small">${esc(c.phone)}</div>
        </div>
        ${c.phone ? `<a class="icon-btn soft" href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}" aria-label="Позвонить">${icon('phone')}</a>` : ''}
        ${chat ? `<button class="icon-btn soft wa-ic" data-act="open" data-url="${esc(chat)}" aria-label="WhatsApp">${icon('chat')}</button>` : ''}
      </div>
      <div class="stats3" style="margin-top:14px">
        <div><span class="hint small">Заказов</span><b>${orders.length}</b></div>
        <div><span class="hint small">На сумму</span><b class="money">${moneyShort(c.total)}</b></div>
        <div><span class="hint small">Долг</span>${c.debt > 0 ? `<b class="debt money">${moneyShort(c.debt)}</b>` : '<b class="ok">нет</b>'}</div>
      </div>
    </div>
    ${clientNoteHtml(key, c)}
    ${arrivedOf(key).length ? `<button class="btn primary" data-act="openHandover" data-key="${esc(key)}">${icon('gift')}Выдать прибывшее (${arrivedOf(key).length})</button>` : ''}
    <button class="btn ${arrivedOf(key).length ? '' : 'primary'}" data-act="newForClient" data-name="${esc(c.name)}" data-phone="${esc(c.phone)}">${icon('plus')}Новый заказ для клиента</button>
    <button class="btn" data-act="reminderSheet" data-key="${esc(key)}" data-name="${esc(c.name)}">${icon('bell')}Напомнить мне про клиента</button>
    ${active.length ? `<div class="section-title">В работе · ${active.length}</div><div class="list">${active.map(orderRow).join('')}</div>` : ''}
    ${closed.length ? `<div class="section-title">Завершённые · ${closed.length}</div><div class="list">${closed.map(orderRow).join('')}</div>` : ''}`;
}

// Поиск по старым заказам на сервере (с паузой, чтобы не искать на каждую букву)
let searchTimer = null;
function searchArchive(q) {
  clearTimeout(searchTimer);
  if (!state.archived || q.trim().length < 2) return;
  searchTimer = setTimeout(async () => {
    try {
      const res = await api('search', { q });
      const before = state.orders.length;
      mergeOrders(res.orders);
      if (state.orders.length !== before && state.query === q && $('#orderList')) $('#orderList').innerHTML = orderListHtml();
    } catch (e) { /* без связи просто ищем среди загруженных */ }
  }, 400);
}

// ---------- Новый заказ ----------

function newItem() {
  return { link: '', size: '', qty: '1', amount: '', currency: '$' };
}

function newDraft() {
  const s = state.settings;
  return {
    client: '', phone: '', opt: false,
    picked: false, who: '', otherName: '', otherPhone: '', // поля клиента (см. clientFieldHtml)
    markup: String(s.retail), markupTouched: false,
    rateUsd: String(s.usd), rateEur: String(s.eur),
    items: [newItem()],
    paidMode: null, paidCustom: '',
    pasteOpen: false, pasteText: '', pasteInfo: '',
  };
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft)); } catch (e) { /* не страшно */ }
}

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (!d || !Array.isArray(d.items)) return null;
    // Черновик из старой версии формы (два поля) — переводим в новую
    if (d.who === undefined) {
      d.who = ''; d.otherName = ''; d.otherPhone = '';
      d.picked = !!(d.client && d.phone);
      if (!d.picked) d.who = d.client || d.phone || '';
    }
    return d;
  } catch (e) { return null; }
}

// Считает цены по форме. Та же формула, что в боте и в таблице.
function calcDraft() {
  const d = state.draft;
  if (!d) return { items: [], total: 0, profit: 0, paid: 0 };
  const markup = parseNum(d.markup) || 0;
  const rates = { '$': parseNum(d.rateUsd) || 0, '€': parseNum(d.rateEur) || 0 };
  const items = d.items.map(it => {
    const qty = Math.max(1, Math.round(parseNum(it.qty)) || 1);
    const amount = parseNum(it.amount) || 0;
    const rate = rates[it.currency];
    const cost = qty * amount * rate;
    return { qty, amount, rate, cost, price: calcPrice(cost, markup, state.settings.round) };
  });
  const total = items.reduce((a, x) => a + x.price, 0);
  const profit = items.reduce((a, x) => a + (x.price ? x.price - x.cost : 0), 0);
  const paid = d.paidMode === 'all' ? total : d.paidMode === 'custom' ? Math.max(0, parseNum(d.paidCustom) || 0) : 0;
  return { items, total, profit, paid, markup, rates };
}

function newOrderTab() {
  const d = state.draft;
  const c = calcDraft();
  const hasEur = d.items.some(x => x.currency === '€');
  const known = d.picked ? findClient(d.client, d.phone) : null;

  const failed = state.failedDraft;
  return `
    ${failed ? `<div class="card failed-card">
      <b>${failed.failed ? 'Не сохранился заказ' : 'Отложен черновик заказа'} для «${esc(failed.client || failed.phone || 'без имени')}»</b>
      <div class="btn-row tight">
        <button class="btn small primary" data-act="restoreFailed">Восстановить</button>
        <button class="btn small" data-act="dropFailed">Удалить</button>
      </div></div>` : ''}
    <div class="card paste-card">
      <button class="paste-btn" data-act="pasteToggle">
        <span class="paste-ic">${icon('paste')}</span>
        <span class="grow"><b>Вставить сообщение клиента</b><span class="hint small">Телефон, ссылки и цены заполнятся сами</span></span>
        <span class="chev ${d.pasteOpen ? 'open' : ''}">${icon('chevron')}</span>
      </button>
      ${d.pasteOpen ? `
        <div style="margin-top:10px">
          <textarea class="input" data-f="pasteText" placeholder="Вставьте сюда текст из WhatsApp: телефон, ссылки, цены, размер…">${esc(d.pasteText)}</textarea>
          <button class="btn primary" data-act="parsePaste" style="margin-top:8px">Заполнить форму</button>
          ${d.pasteInfo ? `<div class="paste-info">${d.pasteInfo}</div>` : ''}
        </div>` : ''}
    </div>

    <div class="section-title">Клиент</div>
    <div class="card">
      ${clientFieldHtml(d, known)}
      <div class="field" style="margin-top:12px">
        <div class="seg">
          <button class="${d.opt ? '' : 'on'}" data-act="opt" data-v="0">Розница</button>
          <button class="${d.opt ? 'on' : ''}" data-act="opt" data-v="1">Опт</button>
        </div>
      </div>
    </div>

    <div class="section-title">Товары</div>
    ${d.items.map((it, i) => itemFormHtml(it, i, c.items[i], d.items.length)).join('')}
    <button class="btn dashed" data-act="addItem">${icon('plus')}Добавить товар</button>

    <div class="section-title">Наценка и курс</div>
    <div class="card">
      <div class="fields-row">
        <div class="field"><label>Наценка, %</label>
          <input class="input" data-f="markup" inputmode="decimal" value="${esc(d.markup)}"></div>
        <div class="field"><label>Курс $, ₸</label>
          <input class="input" data-f="rateUsd" inputmode="decimal" value="${esc(d.rateUsd)}"></div>
        ${hasEur ? `<div class="field"><label>Курс €, ₸</label>
          <input class="input" data-f="rateEur" inputmode="decimal" value="${esc(d.rateEur)}"></div>` : ''}
      </div>
    </div>

    <div class="tile accent wide" style="margin-top:18px">
      <span class="tile-l">Цена клиенту</span>
      <span class="tile-v" id="dTotal">${money(c.total)}</span>
      <span class="tile-s">Ваша прибыль: <b class="ok" id="dProfit">${money(c.profit)}</b></span>
    </div>

    <div class="section-title">Сколько клиент уже оплатил?</div>
    <div class="card">
      <div class="seg ${d.paidMode ? '' : ''}" id="paidSeg">
        <button class="${d.paidMode === 'all' ? 'on' : ''}" data-act="paid" data-v="all">Всё</button>
        <button class="${d.paidMode === 'none' ? 'on' : ''}" data-act="paid" data-v="none">Ничего</button>
        <button class="${d.paidMode === 'custom' ? 'on' : ''}" data-act="paid" data-v="custom">Часть</button>
      </div>
      ${d.paidMode === 'custom' ? `<div class="field" style="margin-top:10px">
        <input class="input" data-f="paidCustom" inputmode="decimal" placeholder="Сумма, ₸" value="${esc(d.paidCustom)}"></div>` : ''}
      <div class="hint" id="dLeft" style="margin-top:8px">${leftText(c)}</div>
    </div>

    <button class="link-btn" data-act="clearDraft" style="margin-top:6px;color:var(--hint)">Очистить форму</button>`;
}

function itemFormHtml(it, i, calc, count) {
  return `
    <div class="card item-card">
      <div class="item-head">
        <span class="row" style="gap:8px"><span class="num">${i + 1}</span>Товар</span>
        ${count > 1 ? `<button class="item-del" data-act="delItem" data-i="${i}">Удалить</button>` : ''}
      </div>
      <div class="field">
        <input class="input" data-f="link" data-i="${i}" value="${esc(it.link)}" placeholder="Ссылка или описание товара" autocomplete="off">
      </div>
      <div class="fields-row">
        <div class="field" style="flex:1.4">
          <input class="input" data-f="size" data-i="${i}" value="${esc(it.size)}" placeholder="Размер / цвет">
        </div>
        <div class="field">
          <div class="stepper">
            <button data-act="qty" data-i="${i}" data-v="-1" aria-label="Меньше">−</button>
            <input data-f="qty" data-i="${i}" inputmode="numeric" value="${esc(it.qty)}" aria-label="Количество">
            <button data-act="qty" data-i="${i}" data-v="1" aria-label="Больше">+</button>
          </div>
        </div>
      </div>
      <div class="fields-row">
        <div class="field" style="flex:1.4">
          <input class="input" data-f="amount" data-i="${i}" inputmode="decimal" value="${esc(it.amount)}"
            placeholder="Цена${Number(it.qty) > 1 ? ' за 1 шт' : ''} на сайте">
        </div>
        <div class="field">
          <div class="seg">
            <button class="${it.currency === '$' ? 'on' : ''}" data-act="cur" data-i="${i}" data-v="$">$</button>
            <button class="${it.currency === '€' ? 'on' : ''}" data-act="cur" data-i="${i}" data-v="€">€</button>
          </div>
        </div>
      </div>
      <div class="item-price row between" id="ip${i}">${itemPriceHtml(it, calc)}</div>
    </div>`;
}

function itemPriceHtml(it, calc) {
  if (!calc || !calc.price) return `<span class="hint">Цена клиенту появится, когда введёте цену</span>`;
  return `<span class="hint">${fmtNum(calc.amount)} ${it.currency} × ${calc.qty} × ${fmtNum(calc.rate)} ₸ + наценка</span>
    <b class="money">${money(calc.price)}</b>`;
}

function leftText(c) {
  if (!state.draft.paidMode) return 'Выберите вариант — так долги не потеряются';
  const left = c.total - c.paid;
  return left > 0 ? `Останется долг: <span class="debt">${money(left)}</span>` : 'Долга не будет ✅';
}

// Пересчитывает суммы, не перерисовывая форму (чтобы не сбивался курсор в поле)
function updateTotals() {
  if (state.tab !== 'new' || state.stack.length) return;
  const c = calcDraft();
  state.draft.items.forEach((it, i) => {
    const el = $('#ip' + i);
    if (el) el.innerHTML = itemPriceHtml(it, c.items[i]);
  });
  $('#dTotal').textContent = money(c.total);
  $('#dProfit').textContent = money(c.profit);
  $('#dLeft').innerHTML = leftText(c);
  updateMainButton();
}

// ---------- Клиент в форме: одно умное поле ----------

// Похоже на телефон? (одни цифры, пробелы, +, скобки, минимум 5 цифр)
function looksLikePhone(t) {
  const v = String(t || '').trim();
  return /^[\d\s+()\-]+$/.test(v) && v.replace(/\D/g, '').length >= 5;
}

// 87075550122 → «8 707 555 01 22», +77075550122 → «+7 707 555 01 22». Чужие форматы не трогаем.
function formatPhone(raw) {
  const v = String(raw || '');
  const plus = v.trim().startsWith('+');
  const d = v.replace(/\D/g, '');
  if (!d) return plus ? '+' : '';
  if ((d[0] !== '7' && d[0] !== '8') || d.length > 11) return v;
  const parts = [];
  let i = 0;
  for (const g of [1, 3, 3, 2, 2]) {
    if (i >= d.length) break;
    parts.push(d.slice(i, i + g));
    i += g;
  }
  return (plus ? '+' : '') + parts.join(' ');
}

function pickDraftClient(name, phone) {
  const d = state.draft;
  d.picked = true;
  d.client = name || '';
  d.phone = phone || '';
  d.who = '';
  d.otherName = '';
  d.otherPhone = '';
}

function clientFieldHtml(d, known) {
  // Клиент выбран — показываем карточку
  if (d.picked) {
    return `
      <div class="picked">
        <span class="ava big">${esc(initials(d.client || '?'))}</span>
        <div class="grow">
          <b class="ellipsis" style="display:block">${esc(d.client || 'Без имени')}</b>
          <span class="hint small">${esc(d.phone || 'без телефона')}</span>
          ${known ? `<div class="known">${icon('check')}Постоянный клиент · ${ordersWord(known.count)}</div>` : ''}
          ${noteFor(d.client, d.phone) ? `<div class="note-line">${icon('note')}${esc(noteFor(d.client, d.phone))}</div>` : ''}
        </div>
        <button class="link-btn" data-act="unpickClient">Изменить</button>
      </div>`;
  }
  // Недавние клиенты — выбрать одним нажатием
  const recent = groupByClient(state.orders).slice(0, 6);
  const phoneMode = looksLikePhone(d.who);
  return `
    ${recent.length ? `<div class="hint small" style="margin:0 2px 6px">Недавние — нажмите, чтобы выбрать</div>
      <div class="chips recent">${recent.map(c =>
        `<button class="chip" data-act="pickClient" data-name="${esc(c.name)}" data-phone="${esc(c.phone)}">${esc(c.name)}</button>`).join('')}</div>` : ''}
    <div class="field">
      <div class="search-wrap" style="margin:0">${icon('search')}
        <input class="input search" data-f="who" value="${esc(d.who)}" placeholder="Имя или телефон" autocomplete="off">
      </div>
      <div class="suggest" id="suggest-who"></div>
    </div>
    ${d.who.trim() ? (phoneMode ? `
      <div class="field">
        <label>Имя <span class="hint small">— можно дописать потом</span></label>
        <input class="input" data-f="otherName" value="${esc(d.otherName)}" placeholder="Как зовут клиента" autocomplete="off">
      </div>` : `
      <div class="field">
        <label>Телефон <span class="hint small">— для WhatsApp</span></label>
        <input class="input" data-f="otherPhone" type="tel" value="${esc(d.otherPhone)}" placeholder="8 7__ ___ __ __" autocomplete="off">
      </div>`) : ''}`;
}

// Ввод в поля клиента: понимаем, что ввели (имя или телефон), форматируем телефон, показываем подсказки
function onClientInput(el, f) {
  const d = state.draft;
  const atEnd = el.selectionStart === el.value.length;
  if (f === 'otherPhone' || (f === 'who' && looksLikePhone(el.value))) {
    const formatted = formatPhone(el.value);
    if (atEnd && formatted !== el.value) el.value = formatted;
  }
  if (f === 'who') {
    const hadSecond = !!$('[data-f="otherName"],[data-f="otherPhone"]');
    const wasPhone = !!$('[data-f="otherName"]');
    d.who = el.value;
    const isPhone = looksLikePhone(d.who);
    if (isPhone) { d.phone = d.who.trim(); d.client = (d.otherName || '').trim(); }
    else { d.client = d.who.trim(); d.phone = (d.otherPhone || '').trim(); }
    const needSecond = !!d.who.trim();
    // Тип ввода поменялся (имя ↔ телефон) или второе поле нужно показать/спрятать — перерисовываем форму
    if (needSecond !== hadSecond || (needSecond && wasPhone !== isPhone)) {
      const pos = el.selectionStart;
      render();
      const again = $('[data-f="who"]');
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    }
    showSuggest(d.who);
  } else if (f === 'otherName') {
    d.otherName = el.value;
    d.client = el.value.trim();
  } else {
    d.otherPhone = el.value;
    d.phone = el.value.trim();
  }
}

// Подсказки клиентов из базы: по имени или по цифрам телефона
function showSuggest(value) {
  const box = $('#suggest-who');
  if (!box) return;
  const q = String(value).trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const byName = /[a-zа-яё]/i.test(q);
  const list = q.length < 2 ? [] : clientList().filter(c =>
    byName ? c.name.toLowerCase().includes(q) : digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits)
  ).slice(0, 5);

  box.innerHTML = list.map(c =>
    `<button data-act="pickClient" data-name="${esc(c.name)}" data-phone="${esc(c.phone)}">
      <span class="row" style="gap:10px"><span class="ava">${esc(initials(c.name))}</span>
        <span><b>${esc(c.name)}</b><br><span class="hint">${esc(c.phone)}</span></span></span>
      <span class="hint nowrap">${ordersWord(c.count)}</span></button>`).join('');
}

// Все клиенты без повторов, свежие — первыми: из сервера (включая архив) + из загруженных заказов
function clientList() {
  const map = new Map();
  state.clients.forEach(c => map.set(clientKey({ phone: c.phone || '', client: c.name }), { ...c }));
  state.orders.slice().sort((a, b) => b.no - a.no).forEach(o => {
    const key = clientKey(o);
    if (!map.has(key)) map.set(key, { name: o.client, phone: o.phone, count: 0 });
    // Сервер уже посчитал заказы, которые были при открытии; добавляем только новые
    if (!state.clients.length || isFresh(o)) map.get(key).count++;
  });
  return [...map.values()];
}

function findClient(name, phone) {
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  if (digits.length < 10) return null;
  return clientList().find(c => c.phone.replace(/\D/g, '').slice(-10) === digits) || null;
}

async function saveOrder() {
  const d = state.draft;
  const c = calcDraft();

  // Проверяем форму и показываем, что не так
  const bad = (sel, msg) => {
    const el = $(sel);
    if (el) { el.classList.add('bad'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    toast(msg, true);
    haptic('error');
  };
  if (!d.client.trim() && !d.phone.trim()) return bad('[data-f="who"]', 'Укажите имя или телефон клиента');
  const filled = d.items.map((it, i) => ({ it, i })).filter(({ it }) => it.link.trim() || it.size.trim() || it.amount.trim());
  if (!filled.length) return bad('[data-f="link"]', 'Добавьте хотя бы один товар');
  const noPrice = filled.find(({ i }) => !(c.items[i].amount > 0));
  if (noPrice) return bad(`[data-f="amount"][data-i="${noPrice.i}"]`, `Укажите цену товара ${noPrice.i + 1}`);
  if (filled.some(({ it }) => it.currency === '$') && !(c.rates['$'] > 0)) return bad('[data-f="rateUsd"]', 'Укажите курс $');
  if (filled.some(({ it }) => it.currency === '€') && !(c.rates['€'] > 0)) return bad('[data-f="rateEur"]', 'Укажите курс €');
  if (!d.paidMode) return bad('#paidSeg', 'Отметьте, сколько клиент оплатил');
  if (d.paidMode === 'custom' && !(parseNum(d.paidCustom) >= 0)) return bad('[data-f="paidCustom"]', 'Напишите сумму оплаты');

  const payload = {
    order: {
      client: d.client.trim() || `Клиент ${d.phone.replace(/\D/g, '').slice(-4)}`, phone: d.phone.trim(), opt: d.opt,
      markup: c.markup, rates: { usd: c.rates['$'], eur: c.rates['€'] },
      items: filled.map(({ it, i }) => ({
        link: it.link.trim(), size: it.size.trim(), qty: c.items[i].qty, amount: c.items[i].amount, currency: it.currency,
      })),
      paid: c.paid, paidAll: d.paidMode === 'all',
    },
  };

  // Чек показываем сразу (суммы посчитаны на телефоне по той же формуле), номер подставим, когда ответит таблица
  const preview = {
    no: null, client: payload.order.client, phone: payload.order.phone,
    items: filled.map(({ it, i }) => ({ link: it.link.trim(), size: it.size.trim(), qty: c.items[i].qty, price: c.items[i].price })),
    total: c.total, paid: c.paid, debt: c.total - c.paid, profit: c.profit,
  };
  const savedDraft = JSON.parse(JSON.stringify(d));
  const temp = 'new-' + Date.now();
  haptic('success');
  state.draft = newDraft();
  saveDraft();
  openScreen({ type: 'done', no: null, temp, preview });

  syncPending++;
  updateSyncBadge();
  syncQueue = syncQueue.then(async () => {
    try {
      const res = await api('createOrder', payload);
      mergeOrders(res.orders);
      if (res.settings) state.settings = res.settings;
      const no = res.orders[0].no;
      const screen = state.stack.find(x => x.temp === temp);
      if (screen) { screen.no = no; delete screen.preview; }
      if (currentScreen() !== screen) toast(`Заказ №${no} сохранён ✅`);
    } catch (err) {
      console.error(err);
      onOrderFailed(savedDraft, temp, err);
    } finally {
      syncPending--;
      updateSyncBadge();
      saveCacheSoon();
      softRender();
    }
  });
}

function isBlankDraft(d) {
  return !d.client && !d.phone && !d.who && d.items.every(it => !it.link.trim() && !it.amount.trim() && !it.size.trim());
}

// Заказ не сохранился: возвращаем заполненную форму, чтобы ничего не вводить заново
function onOrderFailed(savedDraft, temp, err) {
  const msg = err instanceof TypeError ? 'нет связи' : (err.message || 'ошибка');
  state.stack = state.stack.filter(x => x.temp !== temp);
  if (isBlankDraft(state.draft)) {
    state.draft = savedDraft;
    saveDraft();
    state.stack = [];
    state.tab = 'new';
    toast(`Заказ не сохранился (${msg}). Форма заполнена как была — нажмите «Сохранить» ещё раз`, true);
  } else {
    // Байер уже начал следующий заказ — не затираем его, предлагаем восстановить кнопкой
    savedDraft.failed = true;
    state.failedDraft = savedDraft;
    toast(`Заказ для «${savedDraft.client || savedDraft.phone}» не сохранился (${msg}). Его можно восстановить во вкладке «Новый»`, true);
  }
  haptic('error');
  render();
}

// ---------- Быстрая вставка сообщения клиента ----------

// Вытаскивает из текста телефон, ссылки, цены и размер. Простыми правилами, без ИИ.
function parseMessage(text) {
  const phoneMatch = text.match(/(?:\+?7|8)[\s\-()]*7\d{2}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/);
  const links = text.match(/https?:\/\/[^\s<>"']+/g) || [];
  // Цены ищем в тексте без ссылок и телефона, чтобы не принять цифры из них за цену
  let rest = text.replace(/https?:\/\/\S+/g, ' ');
  if (phoneMatch) rest = rest.replace(phoneMatch[0], ' ');

  const prices = [];
  const re = /([$€])\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(\$|€|usd|eur|евро|долл\w*|бакс\w*)/gi;
  let m;
  while ((m = re.exec(rest))) {
    const sign = (m[1] || m[4] || '').toLowerCase();
    const amount = parseFloat((m[2] || m[3]).replace(',', '.'));
    if (amount > 0) prices.push({ amount, currency: /€|eur|евро/.test(sign) ? '€' : '$' });
  }

  const parts = [];
  const size = rest.match(/(?:размер[ыа]?|р-р|разм\.?|size)\s*[:\-–]?\s*([^\n,;]{1,20})/i);
  if (size) parts.push(size[1].trim());
  else {
    const letter = rest.match(/(?:^|[\s,(])(XXS|XS|S|M|L|XL|XXL|XXXL)(?=$|[\s,.)])/);
    if (letter) parts.push(letter[1]);
  }
  const color = rest.match(/(?:цвет|color)\s*[:\-–]?\s*([^\n,;]{1,20})/i);
  if (color) parts.push(color[1].trim());

  return { phone: phoneMatch ? phoneMatch[0].trim() : '', links, prices, size: parts.join(' · ') };
}

function applyPaste() {
  const d = state.draft;
  const p = parseMessage(d.pasteText || '');
  const found = [];

  if (p.phone) {
    found.push('телефон');
    const known = findClient('', p.phone);
    if (known && !d.picked) { pickDraftClient(known.name, known.phone); found.push('клиент из базы'); }
    else if (!d.picked) { d.who = formatPhone(p.phone); d.phone = d.who; d.client = (d.otherName || '').trim(); }
  }

  const n = Math.max(p.links.length, p.prices.length, p.size ? 1 : 0);
  if (n) {
    const blank = d.items.every(it => !it.link.trim() && !it.amount.trim() && !it.size.trim());
    if (blank) d.items = [];
    for (let i = 0; i < n; i++) {
      const it = newItem();
      if (p.links[i]) it.link = p.links[i];
      if (p.prices[i]) { it.amount = String(p.prices[i].amount); it.currency = p.prices[i].currency; }
      if (i === 0 && p.size) it.size = p.size;
      d.items.push(it);
    }
    if (p.links.length) found.push(`ссылок: ${p.links.length}`);
    if (p.prices.length) found.push(`цен: ${p.prices.length}`);
    if (p.size) found.push('размер');
  }

  d.pasteInfo = found.length
    ? `✅ Распознано: ${found.join(', ')}. Проверьте форму и допишите остальное.`
    : '🤔 Ничего не распознано. Заполните форму вручную.';
  if (found.length) d.pasteText = '';
  saveDraft();
  render();
  haptic(found.length ? 'success' : 'warning');
}

// ---------- Выкупить ----------

function buyItems() {
  return state.orders
    .filter(o => statusIdx(o.status) === S.PAID || state.justBought.includes(o.no))
    .flatMap(o => o.items.map(item => ({ order: o, item })));
}

function buyTab() {
  const list = buyItems();
  if (!list.length) return emptyHtml('🎉', 'Нечего выкупать', 'Здесь появятся товары из оплаченных заказов');

  const groups = {};
  list.forEach(x => { (groups[site(x.item.link)] = groups[site(x.item.link)] || []).push(x); });
  const names = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const left = list.filter(x => !x.item.bought);
  const pct = Math.round((list.length - left.length) / list.length * 100);

  return `
    <div class="tile warn wide">
      <span class="tile-l">${icon('cart')}Осталось выкупить</span>
      <span class="tile-v">${left.reduce((a, x) => a + x.item.qty, 0)} шт</span>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <span class="tile-s">Отмечайте купленное. Когда отмечен весь заказ, он сам станет «${esc(state.statuses[S.BOUGHT])}».</span>
    </div>
    ${names.map(name => {
      const g = groups[name];
      const qty = g.reduce((a, x) => a + x.item.qty, 0);
      return `
        <div class="group-h"><span class="ava">${esc(name[0].toUpperCase())}</span><b class="grow ellipsis">${esc(name)}</b><span class="hint">${qty} шт</span></div>
        <div class="list">
          ${g.map(({ order: o, item: it }) => `
            <div class="buy-item ${it.bought ? 'done' : ''}">
              <button class="cb" data-act="buyToggle" data-no="${o.no}" data-id="${it.id}" aria-label="Выкуплен">${it.bought ? icon('check') : ''}</button>
              <div class="grow">
                <div class="ellipsis">${esc(productName(it.link))}</div>
                <div><b>${esc(it.size || 'без размера')}</b>${it.qty > 1 ? ` · <b>${it.qty} шт</b>` : ''}</div>
                <div class="hint small">№${o.no} · ${esc(o.client)}</div>
              </div>
              ${isUrl(it.link) ? `<button class="icon-btn soft" data-act="open" data-url="${esc(it.link)}" aria-label="Открыть ссылку">${icon('external')}</button>` : ''}
            </div>`).join('')}
        </div>`;
    }).join('')}`;
}

// ---------- Долги ----------

function debtOrders() {
  return state.orders.filter(o => o.debt > 0 && !isCancelled(o)).sort((a, b) => b.debt - a.debt);
}

function debtsTab() {
  const list = debtOrders();
  if (!list.length) return emptyHtml('✅', 'Долгов нет', 'Все клиенты рассчитались');
  const sum = list.reduce((a, o) => a + o.debt, 0);
  return `
    <div class="tile danger wide">
      <span class="tile-l">${icon('wallet')}Клиенты должны</span>
      <span class="tile-v">${money(sum)}</span>
      <span class="tile-s">${ordersWord(list.length)} с долгом · сначала самые крупные</span>
    </div>
    <div class="list">
      ${list.map(o => {
        const remind = waLink(o.phone, fillText(state.texts.remind, o));
        return `
          <div class="lrow stripe col" style="${statusStyle(statusIdx(o.status))}">
            <div class="row" data-act="openOrder" data-no="${o.no}">
              <div class="grow">
                <div class="l1"><span class="name ellipsis">${esc(o.client)}</span></div>
                <div class="l2">№${o.no} · <span class="st">${esc(o.status)}</span> · ${daysSince(o.date) >= 30 ? `<span class="debt">${daysWord(daysSince(o.date))}</span>` : daysWord(daysSince(o.date))}</div>
              </div>
              <div class="debt money big-debt">${money(o.debt)}</div>
            </div>
            <div class="btn-row tight">
              <button class="btn small" data-act="payment" data-no="${o.no}">${icon('cash')}Оплата</button>
              ${remind ? `<button class="btn small wa" data-act="open" data-url="${esc(remind)}">${icon('chat')}Напомнить</button>` : ''}
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

// =====================================================================
//  ЭКРАНЫ ПОВЕРХ ВКЛАДОК
// =====================================================================

const SCREENS = {
  order: orderScreen,
  summary: summaryScreen,
  done: doneScreen,
  client: clientScreen,
  calc: calcScreen,
  settings: settingsScreen,
  buy: buyTab,
  debts: debtsTab,
  attention: attentionScreen,
  parcel: parcelScreen,
  handoverList: handoverListScreen,
  handover: handoverScreen,
};

// ---------- Карточка заказа ----------

const FLOW = [S.WAIT, S.PAID, S.BOUGHT, S.STOCK, S.WAY, S.ARRIVED, S.DONE]; // путь заказа без «Отменён»

function orderScreen({ no }) {
  const o = findOrder(no);
  if (!o) return emptyHtml('🤷', 'Заказ не найден');
  const cur = statusIdx(o.status);
  const cancelled = cur === S.CANCEL;
  const next = cur >= 0 && cur < S.DONE ? cur + 1 : null;
  const msg = statusMessage(o);
  const msgUrl = msg && waLink(o.phone, msg);
  const chat = waLink(o.phone, '');
  const receiptUrl = waLink(o.phone, receiptText(o));
  const tel = o.phone ? `tel:${o.phone.replace(/[^\d+]/g, '')}` : '';

  return `
    <div class="card">
      <div class="row">
        <span class="ava big">${esc(initials(o.client))}</span>
        <div class="grow">
          <b class="ellipsis" style="display:block;font-size:18px">${esc(o.client)}</b>
          <div class="hint small">${fmtDate(o.date, true)} · ${o.opt ? 'Опт' : 'Розница'}${o.phone ? ' · ' + esc(o.phone) : ''}</div>
        </div>
        ${tel ? `<a class="icon-btn soft" href="${esc(tel)}" aria-label="Позвонить">${icon('phone')}</a>` : ''}
        ${chat ? `<button class="icon-btn soft wa-ic" data-act="open" data-url="${esc(chat)}" aria-label="WhatsApp">${icon('chat')}</button>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="row between"><span class="hint">Статус</span>${pill(o.status)}</div>
      ${cancelled ? '' : `
        <div class="steps" style="${statusStyle(cur)}">${FLOW.map(i => `<span class="${i <= cur ? 'on' : ''}"></span>`).join('')}</div>
        <div class="hint small">Этап ${cur + 1} из ${FLOW.length}${next !== null ? ` · дальше: ${esc(state.statuses[next])}` : ' · заказ завершён'}</div>`}
      ${next !== null ? `<button class="btn primary" data-act="setStatus" data-no="${o.no}" data-i="${next}" style="margin-top:12px">
        Перевести в «${esc(state.statuses[next])}»${icon('arrow')}</button>` : ''}
      <button class="btn ghost" data-act="statusSheet" data-no="${o.no}">Выбрать другой статус</button>
    </div>

    ${msgUrl ? `<button class="btn wa" data-act="open" data-url="${esc(msgUrl)}">${icon('chat')}Сообщить клиенту в WhatsApp</button>` : ''}

    <div class="section-title">Деньги</div>
    <div class="card">
      <div class="stats3">
        <div><span class="hint small">Сумма</span><b class="money">${money(o.total)}</b></div>
        <div><span class="hint small">Оплачено</span><b class="money">${money(o.paid)}</b></div>
        <div><span class="hint small">Долг</span>${o.debt > 0 ? `<b class="debt money">${money(o.debt)}</b>` : '<b class="ok">нет</b>'}</div>
      </div>
      <div class="hint small" style="margin-top:8px">Ваша прибыль: ${money(o.profit)}</div>
      ${o.debt > 0 && !cancelled ? `<button class="btn primary" data-act="payment" data-no="${o.no}" style="margin-top:12px">${icon('cash')}Внести оплату</button>` : ''}
    </div>

    <div class="section-title">Товары · ${o.count} шт</div>
    <div class="list">
      ${o.items.map(it => `
        <div class="lrow" ${isUrl(it.link) ? `data-act="open" data-url="${esc(it.link)}"` : ''}>
          <span class="mark ${it.bought ? 'on' : ''}" title="${it.bought ? 'Выкуплен' : 'Не выкуплен'}">${it.bought ? icon('check') : ''}</span>
          <div class="grow">
            <div class="l1"><span class="name ellipsis">${esc(itemLabel(it))}</span></div>
            <div class="l2">${fmtNum(it.amount)} ${it.currency} × ${it.qty} · курс ${fmtNum(it.rate)} · +${fmtNum(it.markup)}%</div>
          </div>
          <div class="rt"><div class="money">${money(it.price)}</div></div>
        </div>`).join('')}
    </div>

    <div class="section-title">Трек-номер</div>
    <div class="card">
      <div class="row">
        <input id="trackEdit" class="input grow" value="${esc(o.track)}" placeholder="Нет трек-номера" autocomplete="off">
        <button class="btn small" data-act="saveTrack" data-no="${o.no}">Сохранить</button>
      </div>
    </div>

    ${receiptUrl ? `<button class="btn" data-act="open" data-url="${esc(receiptUrl)}">${icon('receipt')}Отправить чек в WhatsApp</button>` : ''}
    <div class="btn-row">
      <button class="btn small" data-act="trackShare" data-no="${o.no}">${icon('link')}Ссылка для клиента</button>
      <button class="btn small" data-act="reminderSheet" data-no="${o.no}">${icon('bell')}Напомнить мне</button>
    </div>`;
}

// ---------- Заказ сохранён ----------

function doneScreen(top) {
  const pending = !top.no;
  const o = pending ? top.preview : findOrder(top.no);
  if (!o) return emptyHtml('🤷', 'Заказ не найден');
  const url = waLink(o.phone, receiptText(o));
  let waButton;
  if (!o.phone) waButton = `<p class="hint" style="text-align:center">Чтобы отправить чек в WhatsApp, укажите телефон клиента</p>`;
  else if (pending) waButton = `<button class="btn wa" disabled>${icon('chat')}Чек будет готов через пару секунд…</button>`;
  else waButton = `<button class="btn wa" data-act="open" data-url="${esc(url)}">${icon('chat')}Отправить чек в WhatsApp</button>`;
  return `
    <div class="done-head">
      <span class="done-ic ${pending ? 'pending' : ''}">${icon('check')}</span>
      <b>${pending ? 'Заказ сохраняется…' : `Заказ №${o.no} сохранён`}</b>
      <span class="hint">${pending ? 'Номер появится через пару секунд · ' : ''}Ваша прибыль: <span class="ok">${money(o.profit)}</span></span>
    </div>
    <div class="card"><pre class="receipt">${esc(receiptText(o))}</pre></div>
    ${waButton}
    <button class="btn primary" data-act="newOrder">${icon('plus')}Ещё заказ</button>
    ${pending ? '' : `<button class="btn" data-act="doneOpenOrder" data-no="${o.no}">Открыть заказ</button>`}`;
}

// ---------- Сводка (как утренняя сводка в боте) ----------

function summaryScreen() {
  const orders = state.orders.filter(inSummary);
  const by = i => orders.filter(o => statusIdx(o.status) === i);
  const sum = (arr, key) => arr.reduce((a, o) => a + o[key], 0);
  const block = (title, arr) => !arr.length ? '' : `
    <div class="section-title">${title} · ${arr.length}</div>
    <div class="list">${arr.slice().sort((a, b) => b.no - a.no).map(orderRow).join('')}</div>`;

  const goingCount = GOING.reduce((a, i) => a + by(i).length, 0);
  const debts = debtOrders();
  const now = new Date();
  const month = orders.filter(o => {
    const d = new Date(o.date);
    return !isCancelled(o) && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const arch = state.monthArchived || { count: 0, total: 0, profit: 0 };
  const monthName = now.toLocaleString('ru-RU', { month: 'long' });

  return `
    <div class="section-title">Итоги за ${esc(monthName)}</div>
    <div class="tiles">
      <div class="tile accent"><span class="tile-l">Выручка</span><span class="tile-v">${moneyShort(sum(month, 'total') + arch.total)}</span>
        <span class="tile-s">${ordersWord(month.length + arch.count)}</span></div>
      <div class="tile ok"><span class="tile-l">Прибыль</span><span class="tile-v">${moneyShort(sum(month, 'profit') + arch.profit)}</span>
        <span class="tile-s">после закупки</span></div>
      ${debts.length ? `<button class="tile danger" data-act="tabDebts"><span class="tile-l">${icon('wallet')}Должны</span>
        <span class="tile-v">${moneyShort(sum(debts, 'debt'))}</span><span class="tile-s">${ordersWord(debts.length)}</span></button>` : ''}
      ${goingCount ? `<button class="tile neutral" data-act="tile" data-v="going"><span class="tile-l">${icon('truck')}Едут</span><span class="tile-v">${goingCount}</span>
        <span class="tile-s">выкуп ${by(S.BOUGHT).length} · склад ${by(S.STOCK).length} · путь ${by(S.WAY).length}</span></button>` : ''}
    </div>
    ${block('Выкупить', by(S.PAID))}
    ${block('Ждут оплаты', by(S.WAIT))}
    ${block('Прибыли, ждут выдачи', by(S.ARRIVED))}
    ${DEMO ? `<button class="btn ghost danger" data-act="resetDemo" style="margin-top:20px">Сбросить демо-данные</button>` : ''}`;
}

// =====================================================================
//  НИЖНЯЯ ПАНЕЛЬ: статус, трек-номер, оплата
// =====================================================================

function openSheet(name, html) {
  state.sheet = name;
  $('#sheet').innerHTML = `<div class="grip"></div>` + html;
  $('#sheet').hidden = false;
  $('#sheetBg').hidden = false;
  updateMainButton();
  if (IN_TG) tg.BackButton.show();
}

function closeSheet(rerender = true) {
  if (!state.sheet) return;
  state.sheet = null;
  $('#sheet').hidden = true;
  $('#sheetBg').hidden = true;
  if (rerender) render();
}

// Список статусов: строка с цветной точкой. act — что делать при выборе, cur — текущий статус
function statusListHtml(act, extra, cur) {
  return `<div class="list slist">${state.statuses.map((s, i) => `
    <button class="lrow srow ${i === cur ? 'cur' : ''}" style="${statusStyle(i)}" data-act="${act}" data-i="${i}" ${extra}>
      <span class="dot"></span><span class="grow">${esc(s)}</span>${i === cur ? icon('check') : ''}
    </button>`).join('')}</div>`;
}

function openStatusSheet(no) {
  const o = findOrder(no);
  if (!o) return;
  openSheet('status', `
    <h3>Статус заказа №${o.no}</h3>
    ${statusListHtml('pickStatus', `data-no="${o.no}"`, statusIdx(o.status))}
    <button class="btn" data-act="sheetClose" style="margin-top:12px">Отмена</button>`);
}

function openBulkStatusSheet() {
  openSheet('bulk', `
    <h3>Статус для ${ordersWord(state.selected.length)}</h3>
    ${statusListHtml('bulkPick', '', -1)}
    <button class="btn" data-act="sheetClose" style="margin-top:12px">Отмена</button>`);
}

// Для «В пути» сначала спрашиваем трек-номер
function askStatus(nos, i) {
  const needTrack = i === S.WAY && nos.some(no => !findOrder(no).track);
  if (!needTrack) return applyStatus(nos, i, '');
  openSheet('track', `
    <h3>Трек-номер посылки</h3>
    <p class="hint" style="margin-top:-6px">${nos.length > 1 ? 'Общий для всех выбранных заказов. ' : ''}Его увидит клиент в сообщении.</p>
    <input id="trackInput" class="input" placeholder="Например, NW123456789US" autocomplete="off">
    <button class="btn primary" data-act="trackSave" data-nos="${JSON.stringify(nos)}" data-i="${i}" style="margin-top:10px">Сохранить</button>
    <button class="btn" data-act="trackSkip" data-nos="${JSON.stringify(nos)}" data-i="${i}">Без трек-номера</button>`);
  setTimeout(() => $('#trackInput') && $('#trackInput').focus(), 100);
}

function applyStatus(nos, i, track) {
  const snap = mutate(nos, o => setLocalStatus(o, i, track), 'setStatus', { nos, status: state.statuses[i], track });
  haptic('success');
  closeSheet(false);
  state.selecting = false;
  state.selected = [];
  render();
  const text = nos.length === 1 ? `№${nos[0]} → ${state.statuses[i]}` : `${ordersWord(nos.length)} → ${state.statuses[i]}`;
  offerUndo(text, snap);
  if (nos.length > 1) showNotifySheet(nos.map(findOrder).filter(Boolean), text);
}

// Несколько заказов поменяли статус: кнопки WhatsApp для каждого клиента
function showNotifySheet(orders, title) {
  const rows = orders.map(o => {
    const text = statusMessage(o);
    const url = text && waLink(o.phone, text);
    return url ? `<button class="btn wa" data-act="open" data-url="${esc(url)}">${icon('chat')}№${o.no} ${esc(o.client)}</button>` : '';
  }).join('');
  if (!rows) return;
  openSheet('notify', `
    <h3>${esc(title)}</h3>
    <p class="hint" style="margin-top:-6px">Сообщите клиентам — нажмите на каждого:</p>
    ${rows}
    <button class="btn" data-act="sheetClose" style="margin-top:12px">Готово</button>`);
}

function openPaymentSheet(no) {
  const o = findOrder(no);
  if (!o) return;
  const remind = waLink(o.phone, fillText(state.texts.remind, o));
  openSheet('payment', `
    <h3>Оплата · №${o.no} ${esc(o.client)}</h3>
    <p style="margin-top:-6px">Долг: <span class="debt money">${money(o.debt)}</span></p>
    <button class="btn primary" data-act="payAll" data-no="${o.no}">${icon('check')}Оплачен весь долг — ${money(o.debt)}</button>
    <div class="section-title">Или часть суммы</div>
    <div class="row">
      <input id="payInput" class="input grow" inputmode="decimal" placeholder="Сумма, ₸">
      <button class="btn small" data-act="paySubmit" data-no="${o.no}">Внести</button>
    </div>
    ${remind ? `<button class="btn wa" data-act="open" data-url="${esc(remind)}" style="margin-top:16px">${icon('chat')}Напомнить в WhatsApp</button>` : ''}
    ${state.settings.paymentDetails && o.phone ? `<button class="btn" data-act="sendDetails" data-no="${o.no}">${icon('cash')}Отправить реквизиты</button>`
      : !state.settings.paymentDetails ? `<p class="hint small" style="margin:10px 2px 0">Укажите реквизиты в ⚙️ Настройках — и их можно будет отправить клиенту одной кнопкой.</p>` : ''}`);
}

function addPayment(no, amount) {
  const snap = mutate([no], o => {
    o.paid += amount;
    o.debt = o.total - o.paid;
    if (statusIdx(o.status) === S.WAIT) setLocalStatus(o, S.PAID);
  }, 'addPayment', { no, amount });
  haptic('success');
  closeSheet(false);
  render();
  const o = findOrder(no);
  offerUndo(o.debt > 0 ? `Внесено ${money(amount)}. Осталось ${money(o.debt)}` : 'Долг закрыт ✅', snap);
}

// =====================================================================
//  ОТМЕНА ПОСЛЕДНЕГО ДЕЙСТВИЯ
//  Перед изменением запоминаем, какими были заказы. «Отменить» — вернуть как было.
// =====================================================================

let undoSnap = null;

function snapshot(nos) {
  return [].concat(nos).map(n => findOrder(n)).filter(Boolean).map(o => JSON.parse(JSON.stringify(o)));
}

function offerUndo(text, snap) {
  undoSnap = snap && snap.length ? snap : null;
  toast(text, false, !!undoSnap);
}

function doUndo() {
  const snap = undoSnap;
  undoSnap = null;
  hideToast();
  if (!snap) return;
  mutate(snap.map(o => o.no), o => {
    Object.assign(o, JSON.parse(JSON.stringify(snap.find(x => x.no === o.no))));
  }, 'restore', { orders: snap });
  haptic('light');
  closeSheet(false);
  render();
  toast('Отменено');
}

// =====================================================================
//  «ТРЕБУЕТ ВНИМАНИЯ»: заказы, которые застряли или о которых забыли
// =====================================================================

function daysSince(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000));
}

// 1 день, 3 дня, 5 дней
function daysWord(n) {
  const d = n % 10, h = n % 100;
  const w = d === 1 && h !== 11 ? 'день' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'дня' : 'дней';
  return `${n} ${w}`;
}

function attentionItems() {
  const t = Object.assign({ wait: 3, paid: 3, way: 25, arrived: 5 }, state.settings.attention || {});
  const now = Date.now();
  const out = [];
  state.orders.forEach(o => {
    if (o.snoozeUntil && new Date(o.snoozeUntil) > now) return;
    const i = statusIdx(o.status);
    const since = daysSince(o.statusAt || o.date);
    const age = daysSince(o.date);
    const remind = () => waLink(o.phone, fillText(state.texts.remind, o));
    // prio: чем меньше, тем выше в списке
    if (i === S.PAID && since >= t.paid) {
      out.push({ o, prio: 1, days: since, text: `оплачен ${daysWord(since)} назад, не выкуплен`, btn: 'Выкупить', act: 'openBuy' });
    } else if (i === S.ARRIVED && since >= t.arrived) {
      out.push({ o, prio: 2, days: since, text: `прибыл ${daysWord(since)} назад, не забирают`, btn: 'Написать', url: waLink(o.phone, statusMessage(o)) });
    } else if (i === S.WAIT && age >= t.wait) {
      out.push({ o, prio: 3, days: age, text: `не оплачен ${daysWord(age)}`, btn: 'Напомнить', url: remind() });
    } else if (i === S.DONE && o.debt > 0) {
      out.push({ o, prio: 4, days: since, text: `выдан, но долг ${money(o.debt)}`, btn: 'Напомнить', url: remind() });
    } else if (i === S.WAY && since >= t.way) {
      out.push({ o, prio: 5, days: since, text: `в пути уже ${daysWord(since)} — проверьте посылку`, btn: 'Открыть', act: 'openOrder' });
    }
  });
  return out.sort((a, b) => a.prio - b.prio || b.days - a.days);
}

function attentionRow(x) {
  const o = x.o;
  const button = x.url
    ? `<button class="btn small wa" data-act="attnWrite" data-no="${o.no}" data-url="${esc(x.url)}">${icon('chat')}${x.btn}</button>`
    : `<button class="btn small" data-act="${x.act}" data-no="${o.no}">${x.btn}</button>`;
  return `
    <div class="lrow stripe" style="${statusStyle(statusIdx(o.status))}">
      <div class="grow" data-act="openOrder" data-no="${o.no}">
        <div class="l1"><span class="name ellipsis">${esc(o.client)}</span></div>
        <div class="l2">№${o.no} · <span class="warn-text">${esc(x.text)}</span></div>
      </div>
      ${button}
    </div>`;
}

function attentionScreen() {
  const list = attentionItems();
  if (!list.length) return emptyHtml('✅', 'Всё под контролем', 'Застрявших и забытых заказов нет');
  return `
    <p class="hint" style="margin:4px 4px 10px">После «Напомнить» или «Написать» заказ пропадает отсюда на 2 дня.</p>
    <div class="list">${list.map(attentionRow).join('')}</div>`;
}

// =====================================================================
//  ПРИШЛА ПОСЫЛКА: все заказы с одним трек-номером → «Прибыл»
// =====================================================================

function normTrack(t) { return String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// Посылки, которые сейчас едут: заказы «В пути», сгруппированные по трек-номеру
function parcelsOnWay() {
  const map = new Map();
  state.orders.filter(o => statusIdx(o.status) === S.WAY && o.track).forEach(o => {
    const k = normTrack(o.track);
    if (!map.has(k)) map.set(k, { track: o.track, orders: [], since: 0 });
    const p = map.get(k);
    p.orders.push(o);
    p.since = Math.max(p.since, daysSince(o.statusAt || o.date));
  });
  return [...map.values()].sort((a, b) => b.since - a.since);
}

function parcelOrders(track) {
  const t = normTrack(track);
  if (t.length < 4) return [];
  return state.orders.filter(o => {
    const i = statusIdx(o.status);
    return o.track && normTrack(o.track).includes(t) && i >= S.PAID && i < S.ARRIVED;
  }).sort((a, b) => a.no - b.no);
}

function pickParcel(track) {
  const top = currentScreen();
  const found = parcelOrders(track);
  if (!found.length) {
    toast('Заказов с таким трек-номером в пути нет', true);
    const el = $('#parcelInput');
    if (el) el.classList.add('bad');
    return;
  }
  top.track = track;
  top.sel = found.map(o => o.no);
  render();
  window.scrollTo(0, 0);
}

function parcelScreen(top) {
  if (top.track) {
    const found = parcelOrders(top.track);
    const all = found.every(o => top.sel.includes(o.no));
    return `
      <div class="card">
        <div class="hint small">Трек-номер</div>
        <div class="row between"><b class="mono">${esc(top.track)}</b>
          <button class="link-btn" data-act="parcelReset">Другая посылка</button></div>
      </div>
      <div class="section-title">${ordersWord(found.length)} в этой посылке${all ? '' : ` · выбрано ${top.sel.length}`}</div>
      <div class="list">
        ${found.map(o => {
          const on = top.sel.includes(o.no);
          return `
            <div class="lrow ${on ? 'checked' : ''}" data-act="parcelToggle" data-no="${o.no}">
              <span class="check">${on ? '✓' : ''}</span>
              <div class="grow">
                <div class="l1"><span class="name ellipsis">${esc(o.client)}</span></div>
                <div class="l2">№${o.no} · ${o.count} шт${o.debt > 0 ? ` · <span class="debt">к доплате ${money(o.debt)}</span>` : ''}</div>
              </div>
            </div>`;
        }).join('')}
      </div>
      <p class="hint" style="margin:0 4px">Снимите галочку, если какого-то заказа не оказалось в посылке.</p>`;
  }

  const parcels = parcelsOnWay();
  return `
    <div class="card">
      <label class="hint small" for="parcelInput">Трек-номер посылки</label>
      <div class="row" style="margin-top:6px">
        <input id="parcelInput" class="input grow mono" placeholder="Вставьте или введите" autocomplete="off">
        <button class="btn small primary" data-act="parcelFind">Найти</button>
      </div>
    </div>
    ${parcels.length ? `
      <div class="section-title">Или выберите посылку в пути</div>
      <div class="list">
        ${parcels.map(p => `
          <div class="lrow" data-act="parcelPick" data-track="${esc(p.track)}">
            <span class="ava">${icon('truck')}</span>
            <div class="grow">
              <div class="l1"><span class="name ellipsis mono">${esc(p.track)}</span></div>
              <div class="l2">${ordersWord(p.orders.length)} · в пути ${daysWord(p.since)}</div>
            </div>
            <span class="hint">${icon('chevron')}</span>
          </div>`).join('')}
      </div>` : emptyHtml('📭', 'Посылок в пути нет', 'Здесь появятся заказы со статусом «В пути» и трек-номером')}`;
}

function applyParcel() {
  const top = currentScreen();
  const nos = top.sel.slice();
  if (!nos.length) return;
  const snap = mutate(nos, o => setLocalStatus(o, S.ARRIVED), 'setStatus', { nos, status: state.statuses[S.ARRIVED], track: '' });
  haptic('success');
  state.stack.pop();
  render();
  offerUndo(`${ordersWord(nos.length)} → ${state.statuses[S.ARRIVED]}`, snap);
  showNotifySheet(nos.map(findOrder).filter(Boolean), `Посылка пришла: ${ordersWord(nos.length)}`);
}

// =====================================================================
//  ВЫДАЧА КЛИЕНТУ: все прибывшие заказы клиента + доплата одним экраном
// =====================================================================

function arrivedOf(key) {
  return state.orders.filter(o => clientKey(o) === key && statusIdx(o.status) === S.ARRIVED).sort((a, b) => a.no - b.no);
}

// Какие заказы отмечены для выдачи (по умолчанию — все прибывшие)
function handoverSel(top) {
  const nos = arrivedOf(top.key).map(o => o.no);
  return top.sel === null ? nos : top.sel.filter(n => nos.includes(n));
}

function handoverListScreen() {
  const clients = groupByClient(state.orders.filter(o => statusIdx(o.status) === S.ARRIVED));
  if (!clients.length) return emptyHtml('📭', 'Выдавать пока нечего', 'Здесь появятся клиенты, у которых заказы прибыли');
  return `
    <p class="hint" style="margin:4px 4px 10px">Клиенты, у которых заказы уже прибыли. Нажмите, когда клиент пришёл забирать.</p>
    <div class="list">
      ${clients.map(c => `
        <div class="lrow" data-act="openHandover" data-key="${esc(c.key)}">
          <span class="ava">${esc(initials(c.name))}</span>
          <div class="grow">
            <div class="l1"><span class="name ellipsis">${esc(c.name)}</span></div>
            <div class="l2">${ordersWord(c.orders.length)} · прибыл ${daysWord(Math.max(...c.orders.map(o => daysSince(o.statusAt || o.date))))} назад</div>
          </div>
          <div class="rt">${c.debt > 0 ? `<div class="debt money">${money(c.debt)}</div><div class="hint small">к доплате</div>` : '<div class="ok small">оплачено</div>'}</div>
        </div>`).join('')}
    </div>`;
}

function handoverScreen(top) {
  const list = arrivedOf(top.key);
  if (!list.length) return emptyHtml('✅', 'Всё выдано', 'У клиента нет прибывших заказов');
  const sel = handoverSel(top);
  const chosen = list.filter(o => sel.includes(o.no));
  const due = chosen.reduce((a, o) => a + Math.max(0, o.debt), 0);
  const c = list[0];

  return `
    <div class="card row">
      <span class="ava big">${esc(initials(c.client))}</span>
      <div class="grow"><b style="font-size:18px">${esc(c.client)}</b><div class="hint small">${esc(c.phone)}</div></div>
    </div>
    <div class="section-title">Что выдаём</div>
    <div class="list">
      ${list.map(o => {
        const on = sel.includes(o.no);
        return `
          <div class="lrow ${on ? 'checked' : ''}" data-act="hoToggle" data-no="${o.no}">
            <span class="check">${on ? '✓' : ''}</span>
            <div class="grow">
              <div class="l1"><span class="name">№${o.no}</span><span class="hint small">${o.count} шт</span></div>
              <div class="l2 ellipsis">${esc(o.items.map(itemLabel).join(', '))}</div>
            </div>
            <div class="rt">${o.debt > 0 ? `<div class="debt money">${money(o.debt)}</div>` : '<div class="ok small">оплачен</div>'}</div>
          </div>`;
      }).join('')}
    </div>
    ${due > 0 ? `
      <div class="tile danger wide">
        <span class="tile-l">${icon('cash')}К доплате</span>
        <span class="tile-v">${money(due)}</span>
        <span class="tile-s">Клиент заплатил при выдаче?</span>
        <div class="seg" id="hoPaidSeg" style="width:100%;margin-top:8px;background:var(--bg)">
          <button class="${top.paid === true ? 'on' : ''}" data-act="hoPaid" data-v="1">Да, получил</button>
          <button class="${top.paid === false ? 'on' : ''}" data-act="hoPaid" data-v="0">Нет, в долг</button>
        </div>
      </div>` : `<div class="tile ok wide"><span class="tile-l">${icon('check')}Всё оплачено</span>
        <span class="tile-s">Можно выдавать</span></div>`}`;
}

function applyHandover() {
  const top = currentScreen();
  const nos = handoverSel(top);
  if (!nos.length) return;
  const due = nos.map(findOrder).reduce((a, o) => a + Math.max(0, o.debt), 0);
  if (due > 0 && top.paid === null) {
    toast('Отметьте, получили ли доплату', true);
    const seg = $('#hoPaidSeg');
    if (seg) { seg.classList.add('bad'); seg.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    return;
  }
  const paid = top.paid === true;
  const snap = mutate(nos, o => {
    if (paid && o.debt > 0) { o.paid = o.total; o.debt = 0; }
    setLocalStatus(o, S.DONE);
  }, 'handover', { nos, paid });
  haptic('success');
  state.stack.pop();
  render();
  offerUndo(`Выдано: ${ordersWord(nos.length)}`, snap);
  const o = findOrder(nos[0]);
  const thanks = waLink(o.phone, statusMessage(o));
  if (thanks) {
    openSheet('thanks', `
      <h3>Выдано ✅</h3>
      <p class="hint" style="margin-top:-6px">${esc(o.client)}: ${ordersWord(nos.length)}${due > 0 ? (top.paid ? ', доплата получена' : `, долг ${money(due)} остался`) : ''}</p>
      <button class="btn wa" data-act="open" data-url="${esc(thanks)}">${icon('chat')}Поблагодарить клиента</button>
      <button class="btn" data-act="sheetClose">Готово</button>`);
  }
}

// =====================================================================
//  ВКЛАДКА «СЕГОДНЯ»
// =====================================================================

function todayTab() {
  const by = i => state.orders.filter(o => statusIdx(o.status) === i);
  const toBuy = buyItems().filter(x => !x.item.bought);
  const debts = debtOrders();
  const going = state.orders.filter(o => GOING.includes(statusIdx(o.status)));
  const arrived = by(S.ARRIVED);
  const arrivedClients = groupByClient(arrived).length;
  const attn = attentionItems();
  const parcels = parcelsOnWay().length;
  const now = new Date();
  const dateText = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const tile = (tone, act, v, label, value, sub, ic) => `
    <button class="tile ${tone}" data-act="${act}" ${v !== null ? `data-v="${v}"` : ''}>
      <span class="tile-l">${icon(ic)}${label}</span>
      <span class="tile-v">${value}</span>
      <span class="tile-s">${sub}</span>
    </button>`;

  return `
    <div class="today-date">${esc(dateText)}</div>
    <div class="tiles">
      ${tile('warn', 'openBuy', null, 'Выкупить', `${toBuy.reduce((a, x) => a + x.item.qty, 0)} шт`, ordersWord(by(S.PAID).length), 'cart')}
      ${tile('danger', 'tabDebts', null, 'Должны', moneyShort(debts.reduce((a, o) => a + o.debt, 0)), ordersWord(debts.length), 'wallet')}
      ${tile('accent', 'tile', 'going', 'Едут', going.length, 'выкуп · склад · в пути', 'truck')}
      ${tile('ok', 'openHandoverList', null, 'Выдать', arrived.length, arrivedClients ? `${arrivedClients} клиентам` : 'пока нечего', 'gift')}
    </div>

    <button class="calc-entry" data-act="openCalc">${icon('calc')}<span class="grow"><b>Сколько будет стоить?</b>
      <span class="hint small">Посчитать цену для клиента и ответить в WhatsApp</span></span>${icon('chevron')}</button>
    <div class="quick">
      <button class="btn primary" data-act="newOrderTab">${icon('plus')}Новый заказ</button>
      <button class="btn" data-act="openParcel">Пришла посылка${parcels ? `<span class="pill-n">${parcels}</span>` : ''}</button>
    </div>

    <div class="section-title row between" style="text-transform:none">
      <span class="up">Требует внимания${attn.length ? ` · ${attn.length}` : ''}</span>
      ${attn.length > 5 ? `<button class="link-btn" data-act="openAttention">Все</button>` : ''}
    </div>
    ${attn.length ? `<div class="list">${attn.slice(0, 5).map(attentionRow).join('')}</div>
      ${attn.length > 5 ? `<button class="btn ghost" data-act="openAttention">Показать все ${attn.length}</button>` : ''}`
      : `<div class="card row"><span class="done-ic sm">${icon('check')}</span><div><b>Всё под контролем</b>
        <div class="hint small">Застрявших и забытых заказов нет</div></div></div>`}
    ${remindersTodayHtml()}
    ${birthdaysHtml()}`;
}

// =====================================================================
//  ВКЛАДКА «БИЗНЕС»: цифры по всему делу
//  Данные — короткие строки по всем заказам, включая архив (action 'analytics'),
//  поверх них — свежие заказы, которые уже загружены в приложение.
// =====================================================================

const BIZ_PERIODS = {
  week: { label: 'Неделя', days: 7, prev: 'к прошлой неделе' },
  month: { label: 'Месяц', days: 30, prev: 'к прошлому месяцу' },
  quarter: { label: '3 месяца', days: 90, prev: 'к прошлым 3 мес.' },
  year: { label: 'Год', days: 365, prev: 'к прошлому году' },
};
const BIZ_METRICS = { total: 'Выручка', profit: 'Прибыль', orders: 'Заказы' };
const ANALYTICS_KEY = 'buyercrm-analytics:' + API_URL;
const DAY = 86400000;

async function loadAnalytics() {
  if (state.analyticsLoading) return;
  state.analyticsLoading = true;
  // Сначала — сохранённое с прошлого раза, чтобы вкладка открылась мгновенно
  if (!state.analytics && !DEMO) {
    try {
      const c = JSON.parse(localStorage.getItem(ANALYTICS_KEY));
      if (c && Array.isArray(c.rows)) { state.analytics = c.rows; state.expenses = c.expenses || []; }
    } catch (e) { /* нет сохранённого — подождём сервер */ }
  }
  try {
    const res = await api('analytics');
    state.analytics = res.rows;
    state.expenses = res.expenses || [];
    state.analyticsError = null;
    saveAnalyticsCache();
  } catch (err) {
    if (!state.analytics) state.analyticsError = err instanceof TypeError ? 'Нет связи' : (err.message || 'Ошибка');
  }
  state.analyticsLoading = false;
  if (state.tab === 'biz' && !state.stack.length) softRender();
}

function saveAnalyticsCache() {
  if (DEMO || !state.analytics) return;
  try {
    localStorage.setItem(ANALYTICS_KEY, JSON.stringify({ at: Date.now(), rows: state.analytics, expenses: state.expenses || [] }));
  } catch (e) { /* не страшно */ }
}

// Отправка в таблицу в фоне — для действий, не связанных с одним заказом (расходы, цель)
function queueSync(action, data, onFail) {
  syncPending++;
  updateSyncBadge();
  syncQueue = syncQueue.then(async () => {
    try {
      await api(action, data);
    } catch (err) {
      console.error(err);
      if (onFail) onFail();
      toast(`Не сохранилось (${err instanceof TypeError ? 'нет связи' : (err.message || 'ошибка')}). Вернули как было`, true);
      haptic('error');
    } finally {
      syncPending--;
      updateSyncBadge();
      saveAnalyticsCache();
      softRender();
    }
  });
}

function orderToRow(o) {
  const shops = [];
  o.items.forEach(x => { const s = isUrl(x.link) ? site(x.link) : ''; if (s && !shops.includes(s)) shops.push(s); });
  return {
    no: o.no, date: o.date, client: o.client, phone: o.phone, status: o.status, statusAt: o.statusAt || o.date,
    total: o.total, paid: o.paid, profit: o.profit, cost: o.items.reduce((a, x) => a + (x.cost || 0), 0),
    count: o.count, shops,
  };
}

// Все заказы для аналитики: архив с сервера + свежие из приложения (они важнее — там последние изменения)
function bizRows() {
  const map = new Map();
  (state.analytics || []).forEach(r => map.set(r.no, r));
  state.orders.forEach(o => map.set(o.no, orderToRow(o)));
  return [...map.values()].filter(r => r.status !== state.statuses[S.CANCEL]);
}

// Деление периода на столбики: дни, недели или месяцы
function bizBuckets(period) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const buckets = [];
  if (period === 'year') {
    for (let i = 11; i >= 0; i--) {
      const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ from: from.getTime(), to: Math.min(to.getTime(), end), label: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][from.getMonth()], long: from.toLocaleString('ru-RU', { month: 'long', year: 'numeric' }) });
    }
  } else if (period === 'quarter') {
    for (let i = 12; i >= 0; i--) {
      const to = end - i * 7 * DAY;
      const from = to - 7 * DAY;
      const d = new Date(from);
      buckets.push({ from, to, label: fmtDate(d.toISOString()), long: `неделя с ${fmtDate(d.toISOString())}` });
    }
  } else {
    const n = BIZ_PERIODS[period].days;
    for (let i = n - 1; i >= 0; i--) {
      const from = end - (i + 1) * DAY;
      const d = new Date(from);
      buckets.push({ from, to: from + DAY, label: fmtDate(d.toISOString()), long: d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' }) });
    }
  }
  return buckets;
}

function sumBy(rows, key) { return rows.reduce((a, r) => a + (Number(r[key]) || 0), 0); }

// Изменение к прошлому периоду: «↑ 12% к прошлому месяцу» (зелёным, если стало лучше)
function deltaHtml(now, before, label) {
  if (!before) return `<span class="tile-s">${now ? 'раньше данных нет' : 'нет данных'}</span>`;
  const pct = Math.round((now - before) / before * 100);
  if (pct === 0) return `<span class="tile-s">= ${label}</span>`;
  return `<span class="tile-s"><span class="${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}%</span> ${label}</span>`;
}

// 1 250 000 → «1,3 млн», 45 000 → «45 тыс»
function compactNum(n) {
  const v = Math.abs(n);
  if (v >= 1e6) return String(Math.round(n / 1e5) / 10).replace('.', ',') + ' млн';
  if (v >= 1e3) return Math.round(n / 1e3) + ' тыс';
  return String(Math.round(n));
}

function bizTab() {
  if (!state.analytics) {
    if (!state.analyticsLoading) loadAnalytics();
    if (state.analyticsError) {
      return `<div class="empty"><span class="e-icon">${icon('offline')}</span><b>Не получилось загрузить</b>${esc(state.analyticsError)}<br><br>
        <button class="btn primary" data-act="bizRetry">Повторить</button></div>`;
    }
    return loadingHtml();
  }

  const period = state.bizPeriod;
  const P = BIZ_PERIODS[period];
  const now = Date.now();
  const from = now - P.days * DAY;
  const prevFrom = from - P.days * DAY;
  const rows = bizRows();
  const inRange = (r, a, b) => { const t = new Date(r.date).getTime(); return t >= a && t < b; };
  const cur = rows.filter(r => inRange(r, from, now + DAY));
  const prev = rows.filter(r => inRange(r, prevFrom, from));

  const rev = sumBy(cur, 'total'), revPrev = sumBy(prev, 'total');
  const prof = sumBy(cur, 'profit'), profPrev = sumBy(prev, 'profit');
  const avg = cur.length ? rev / cur.length : 0, avgPrev = prev.length ? revPrev / prev.length : 0;
  const margin = rev ? Math.round(prof / rev * 100) : 0;

  const chips = Object.keys(BIZ_PERIODS).map(k =>
    `<button class="chip ${k === period ? 'on' : ''}" data-act="bizPeriod" data-v="${k}">${BIZ_PERIODS[k].label}</button>`).join('');

  return `
    <div class="chips" style="padding-top:4px">${chips}</div>

    ${bizGoalHtml(rows)}

    <div class="tiles">
      <div class="tile neutral kpi"><span class="tile-l">Выручка</span><span class="tile-v">${moneyShort(rev)}</span>${deltaHtml(rev, revPrev, P.prev)}</div>
      <div class="tile neutral kpi"><span class="tile-l">Прибыль · ${margin}%</span><span class="tile-v ok">${moneyShort(prof)}</span>${deltaHtml(prof, profPrev, P.prev)}</div>
      <div class="tile neutral kpi"><span class="tile-l">Заказов</span><span class="tile-v">${cur.length}</span>${deltaHtml(cur.length, prev.length, P.prev)}</div>
      <div class="tile neutral kpi"><span class="tile-l">Средний чек</span><span class="tile-v">${moneyShort(avg)}</span>${deltaHtml(avg, avgPrev, P.prev)}</div>
    </div>

    <div class="card chart-card">
      <div class="row between" style="margin-bottom:8px">
        <div class="seg seg-sm">${Object.keys(BIZ_METRICS).map(k =>
          `<button class="${k === state.bizMetric ? 'on' : ''}" data-act="bizMetric" data-v="${k}">${BIZ_METRICS[k]}</button>`).join('')}</div>
        <button class="link-btn" data-act="bizTable">${state.bizTable ? 'График' : 'Таблицей'}</button>
      </div>
      <div id="bizChart">${bizChartHtml(cur)}</div>
    </div>

    ${bizNetHtml(prof, from)}
    ${bizSalaryHtml(rev, prof, from)}
    ${bizMoneyHtml()}
    ${bizDebtAgeHtml()}
    ${bizFunnelHtml()}
    ${bizClientsHtml(rows, cur, from)}
    ${bizShopsHtml(cur)}
    ${bizSpeedHtml(rows, from)}
    ${DEMO ? `<button class="btn ghost danger" data-act="resetDemo" style="margin-top:20px">Сбросить демо-данные</button>` : ''}`;
}

// ---------- График по дням / неделям / месяцам ----------

function bizChartHtml(cur) {
  const buckets = bizBuckets(state.bizPeriod);
  const metric = state.bizMetric;
  const val = rs => metric === 'orders' ? rs.length : sumBy(rs, metric);
  buckets.forEach(b => {
    const rs = cur.filter(r => { const t = new Date(r.date).getTime(); return t >= b.from && t < b.to; });
    b.value = val(rs);
    b.orders = rs.length;
  });
  const fmt = v => metric === 'orders' ? `${v}` : money(v);

  if (state.bizTable) {
    return `<div class="lines">${buckets.slice().reverse().map(b =>
      `<div><span>${esc(b.long)}</span><b class="money">${fmt(b.value)}</b></div>`).join('')}</div>`;
  }

  const max = Math.max(...buckets.map(b => b.value), 0);
  if (!max) return `<div class="hint" style="padding:30px 0;text-align:center">За этот период пока пусто</div>`;

  // Ровная шкала: 0, половина, верх (округлённые)
  const mag = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / mag * 2) / 2 * mag;
  const W = 320, H = 150, padL = 44, padB = 20, padT = 8;
  const plotW = W - padL, plotH = H - padB - padT;
  const n = buckets.length;
  const slot = plotW / n;
  const bw = Math.max(3, Math.min(24, slot - 2));
  const sel = state.bizSel != null && state.bizSel < n ? state.bizSel : buckets.findIndex(b => b.value === max);
  const y = v => padT + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const labelEvery = n > 14 ? Math.ceil(n / 6) : 1;

  const bars = buckets.map((b, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const h = Math.max(b.value ? 2 : 0, (b.value / top) * plotH);
    const y0 = padT + plotH;
    const r = Math.min(4, bw / 2, h);
    // Скруглён только верх столбика, низ стоит ровно на оси
    const d = h ? `M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + bw - r} Q${x + bw},${y0 - h} ${x + bw},${y0 - h + r} V${y0} Z` : '';
    return `
      ${d ? `<path d="${d}" class="bar ${i === sel ? 'sel' : ''}"/>` : ''}
      <rect x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH + padB}" fill="transparent"
        data-act="bizBar" data-i="${i}" tabindex="0" aria-label="${esc(b.long)}: ${esc(fmt(b.value))}"/>
      ${(n - 1 - i) % labelEvery === 0 ? `<text x="${padL + i * slot + slot / 2}" y="${H - 5}" class="tick" text-anchor="middle">${esc(b.label)}</text>` : ''}`;
  }).join('');

  const s = buckets[sel];
  return `
    <div class="chart-tip"><b>${esc(fmt(s.value))}</b> <span class="hint">· ${esc(s.long)}${metric !== 'orders' ? ` · ${ordersWord(s.orders)}` : ''}</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(BIZ_METRICS[metric])} по периодам">
      ${ticks.map(t => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/>
        <text x="${padL - 6}" y="${y(t) + 4}" class="tick" text-anchor="end">${metric === 'orders' ? Math.round(t) : compactNum(t)}</text>`).join('')}
      ${bars}
    </svg>`;
}

// ---------- 1. Цель на месяц и прогноз ----------

function bizGoalHtml(rows) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayNo = now.getDate();
  const mtd = sumBy(rows.filter(r => new Date(r.date).getTime() >= monthStart), 'total');
  // Прогноз: если продолжать в том же темпе, сколько выйдет к концу месяца
  const forecast = Math.round(mtd / dayNo * daysInMonth);
  const goal = Number(state.settings.goal) || 0;
  const monthName = now.toLocaleString('ru-RU', { month: 'long' });
  if (!goal) {
    return `<div class="card goal-card row between">
      <div><b>Цель на ${esc(monthName)}</b><div class="hint small">Сейчас ${moneyShort(mtd)}, при таком темпе — ~${moneyShort(forecast)}</div></div>
      <button class="btn small primary" data-act="goalSheet">Поставить</button></div>`;
  }
  const pct = Math.min(100, Math.round(mtd / goal * 100));
  const fpct = Math.round(forecast / goal * 100);
  const onTrack = forecast >= goal;
  const need = Math.max(0, goal - mtd);
  const daysLeft = daysInMonth - dayNo;
  return `
    <div class="card goal-card" data-act="goalSheet">
      <div class="row between"><b>Цель на ${esc(monthName)}</b><span class="hint small">${daysWord(daysLeft)} до конца</span></div>
      <div class="goal-nums"><b class="money">${moneyShort(mtd)}</b> <span class="hint">из ${moneyShort(goal)}</span></div>
      <div class="goal-bar ${onTrack ? 'ok' : 'warn'}"><span style="width:${pct}%"></span><i style="left:${Math.min(100, Math.round(dayNo / daysInMonth * 100))}%"></i></div>
      <div class="small">${onTrack
        ? `<span class="up">✓ Успеваете:</span> при таком темпе выйдет ~${moneyShort(forecast)} (${fpct}% цели)`
        : `<span class="down">Не успеваете:</span> при таком темпе ~${moneyShort(forecast)} (${fpct}%). Нужно ещё ${moneyShort(need)}${daysLeft ? ` — ~${moneyShort(Math.ceil(need / daysLeft / 100) * 100)} в день` : ''}`}</div>
    </div>`;
}

function openGoalSheet() {
  const goal = Number(state.settings.goal) || 0;
  openSheet('goal', `
    <h3>Цель выручки на месяц</h3>
    <p class="hint" style="margin-top:-6px">Приложение покажет, успеваете ли вы, и сколько нужно продавать в день.</p>
    <input id="goalInput" class="input" inputmode="numeric" placeholder="Например, 5 000 000" value="${goal ? esc(String(goal)) : ''}">
    <button class="btn primary" data-act="goalSave" style="margin-top:10px">Сохранить</button>
    ${goal ? `<button class="btn ghost danger" data-act="goalClear">Убрать цель</button>` : ''}`);
  setTimeout(() => $('#goalInput') && $('#goalInput').focus(), 100);
}

function saveGoal(value) {
  const before = state.settings.goal;
  state.settings.goal = value;
  closeSheet(false);
  render();
  toast(value ? `Цель: ${money(value)}` : 'Цель убрана');
  queueSync('setGoal', { goal: value }, () => { state.settings.goal = before; });
  saveCacheSoon();
}

// ---------- 2. Возраст долгов: чем старше долг, тем меньше шанс его получить ----------

function bizDebtAgeHtml() {
  const list = debtOrders();
  if (!list.length) return '';
  const groups = [
    { label: 'До недели', test: d => d < 7, cls: '' },
    { label: '1–4 недели', test: d => d >= 7 && d < 30, cls: 'warn' },
    { label: 'Больше месяца', test: d => d >= 30, cls: 'danger' },
  ].map(g => {
    const os = list.filter(o => g.test(daysSince(o.date)));
    return { ...g, n: os.length, sum: os.reduce((a, o) => a + o.debt, 0), clients: groupByClient(os).length };
  });
  const max = Math.max(...groups.map(g => g.sum), 1);
  const old = groups[2];
  return `
    <div class="section-title">Долги по давности</div>
    <div class="card hbars">
      ${groups.map(g => `
        <div class="hbar" data-act="tabDebts">
          <div class="row between"><span>${g.label}</span>
            <span class="small"><b class="money">${money(g.sum)}</b> <span class="hint">· ${ordersWord(g.n)}</span></span></div>
          <div class="track"><span class="${g.cls}" style="width:${Math.round(g.sum / max * 100)}%"></span></div>
        </div>`).join('')}
      ${old.n ? `<button class="btn small" data-act="tabDebts" style="width:100%">${icon('chat')}Напомнить ${old.clients} ${old.clients === 1 ? 'клиенту' : 'клиентам'} с долгом больше месяца</button>` : ''}
    </div>`;
}

// ---------- 3. Расходы и чистая прибыль ----------

const EXPENSE_CATEGORIES = ['Доставка', 'Комиссии', 'Упаковка', 'Реклама', 'Другое'];

function bizNetHtml(profit, from) {
  const exp = (state.expenses || []).filter(e => new Date(e.date).getTime() >= from)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const total = exp.reduce((a, e) => a + e.amount, 0);
  const net = profit - total;
  const byCat = EXPENSE_CATEGORIES.map(c => ({ c, sum: exp.filter(e => e.category === c).reduce((a, e) => a + e.amount, 0) }))
    .filter(x => x.sum > 0).sort((a, b) => b.sum - a.sum);
  const max = byCat.length ? byCat[0].sum : 1;
  return `
    <div class="section-title row between" style="text-transform:none"><span class="up">Чистая прибыль</span>
      <button class="link-btn" data-act="expenseSheet">${icon('plus')}Расход</button></div>
    <div class="card">
      <div class="lines">
        <div><span>Прибыль с наценки</span><span class="money">${money(profit)}</span></div>
        <div><span>Расходы</span><span class="money">− ${money(total)}</span></div>
        <div><span class="big">Чистая прибыль</span><b class="big money ${net >= 0 ? 'ok' : 'debt'}">${money(net)}</b></div>
      </div>
      ${byCat.length ? `<div class="hbars" style="margin-top:12px">${byCat.map(x => `
        <div class="hbar"><div class="row between"><span>${esc(x.c)}</span><span class="small money">${money(x.sum)}</span></div>
          <div class="track"><span class="muted" style="width:${Math.round(x.sum / max * 100)}%"></span></div></div>`).join('')}</div>`
        : `<p class="hint small" style="margin:10px 0 0">Добавляйте расходы — доставку форвардера, комиссии, упаковку, рекламу, — и здесь будет видно, сколько вы зарабатываете на самом деле.</p>`}
      <button class="btn primary" data-act="expenseSheet" style="margin-top:12px">${icon('plus')}Добавить расход</button>
    </div>
    ${exp.length ? `<div class="list">${exp.slice(0, 5).map(e => `
      <div class="lrow">
        <div class="grow">
          <div class="l1"><span class="name ellipsis">${esc(e.note || e.category)}</span></div>
          <div class="l2">${esc(e.category)} · ${fmtDate(e.date)}</div>
        </div>
        <b class="money">${money(e.amount)}</b>
        <button class="icon-btn soft del-btn" data-act="expenseDelete" data-id="${esc(e.id)}" aria-label="Удалить расход">✕</button>
      </div>`).join('')}</div>` : ''}`;
}

function openExpenseSheet(category) {
  const cat = category || state.lastExpenseCat || 'Доставка';
  openSheet('expense', `
    <h3>Новый расход</h3>
    <input id="expAmount" class="input" inputmode="decimal" placeholder="Сумма, ₸">
    <div class="chips wrap-chips" style="margin:10px 0 0">${EXPENSE_CATEGORIES.map(c =>
      `<button class="chip ${c === cat ? 'on' : ''}" data-act="expenseCat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <input id="expNote" class="input" placeholder="Комментарий (необязательно)" style="margin-top:4px" autocomplete="off">
    <button class="btn primary" data-act="expenseSave" data-cat="${esc(cat)}" style="margin-top:10px">Сохранить</button>`);
  setTimeout(() => $('#expAmount') && $('#expAmount').focus(), 100);
}

function addExpense(amount, category, note) {
  const e = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: new Date().toISOString(), amount, category, note,
  };
  state.expenses = (state.expenses || []).concat(e);
  state.lastExpenseCat = category;
  closeSheet(false);
  render();
  haptic('success');
  toast(`Расход ${money(amount)} записан`);
  queueSync('addExpense', { expense: e }, () => { state.expenses = state.expenses.filter(x => x.id !== e.id); });
}

function deleteExpense(id) {
  const e = (state.expenses || []).find(x => x.id === id);
  if (!e || !confirm(`Удалить расход ${money(e.amount)} (${e.note || e.category})?`)) return;
  state.expenses = state.expenses.filter(x => x.id !== id);
  render();
  queueSync('deleteExpense', { id }, () => { state.expenses = state.expenses.concat(e); });
}

// ---------- «Можно взять себе»: сколько из заработанного — ваши деньги ----------

function bizSalaryHtml(revenue, profit, from) {
  const expenses = (state.expenses || []).filter(e => new Date(e.date).getTime() >= from).reduce((a, e) => a + e.amount, 0);
  const rate = Number(state.settings.taxRate) || 0;
  const tax = Math.round(revenue * rate / 100);
  const salary = profit - expenses - tax;
  // Деньги клиентов на ещё не выкупленные товары — они не ваши, их нельзя тратить
  const reserve = state.orders
    .filter(o => statusIdx(o.status) === S.PAID || statusIdx(o.status) === S.WAIT)
    .reduce((a, o) => a + Math.min(o.paid, o.items.filter(x => !x.bought).reduce((s, x) => s + (x.cost || 0), 0)), 0);
  return `
    <div class="section-title">Можно взять себе</div>
    <div class="card salary-card">
      <div class="lines">
        <div><span>Чистая прибыль</span><span class="money">${money(profit - expenses)}</span></div>
        <div><span>Налог ${rate ? `${fmtNum(rate)}% от выручки` : ''}</span>${rate
          ? `<span class="money">− ${money(tax)}</span>`
          : `<button class="link-btn" data-act="openSettings" style="padding:0">указать ставку</button>`}</div>
        <div><span class="big">Ваша зарплата</span><b class="big money ${salary >= 0 ? 'ok' : 'debt'}">${money(Math.max(0, salary))}</b></div>
      </div>
      ${reserve > 0 ? `<div class="reserve">${icon('lock')}<span>Не тратьте ещё <b class="money">${money(reserve)}</b> — клиенты уже заплатили, а товары пока не выкуплены</span></div>` : ''}
      ${salary < 0 ? `<p class="hint small" style="margin:8px 0 0">Расходы и налог больше прибыли за этот период.</p>` : ''}
    </div>`;
}

// ---------- Деньги прямо сейчас ----------

function bizMoneyHtml() {
  const active = state.orders.filter(o => !isClosed(o));
  const debts = debtOrders().reduce((a, o) => a + o.debt, 0);
  // Вложено в товар: себестоимость уже выкупленных товаров по невыданным заказам
  const inGoods = active.reduce((a, o) => a + o.items.filter(x => x.bought).reduce((s, x) => s + (x.cost || 0), 0), 0);
  const profitAhead = active.reduce((a, o) => a + o.profit, 0);
  return `
    <div class="section-title">Деньги сейчас</div>
    <div class="card lines">
      <div data-act="tabDebts"><span>${icon('wallet')} Должны клиенты</span><b class="debt money">${money(debts)}</b></div>
      <div><span>${icon('cart')} Вложено в товар</span><b class="money">${money(inGoods)}</b></div>
      <div><span>${icon('truck')} Прибыль в работе</span><b class="ok money">${money(profitAhead)}</b></div>
    </div>
    <p class="hint small" style="margin:6px 4px 0">«Вложено в товар» — сколько вы уже потратили на выкуп по заказам, которые ещё не выданы. «Прибыль в работе» — сколько заработаете, когда их выдадите.</p>`;
}

// ---------- Воронка: сколько заказов на каждом этапе ----------

function bizFunnelHtml() {
  const stages = [S.WAIT, S.PAID, S.BOUGHT, S.STOCK, S.WAY, S.ARRIVED];
  const data = stages.map(i => {
    const list = state.orders.filter(o => statusIdx(o.status) === i);
    return { i, n: list.length, sum: sumBy(list, 'total') };
  });
  const max = Math.max(...data.map(d => d.n), 1);
  return `
    <div class="section-title">Заказы по этапам</div>
    <div class="card hbars">
      ${data.map(d => `
        <div class="hbar" data-act="tile" data-v="${d.i}">
          <div class="row between"><span><span class="dot" style="${statusStyle(d.i)}"></span>${esc(state.statuses[d.i])}</span>
            <span class="hint small">${d.n} · ${moneyShort(d.sum)}</span></div>
          <div class="track"><span style="width:${Math.round(d.n / max * 100)}%"></span></div>
        </div>`).join('')}
    </div>`;
}

// ---------- Клиенты ----------

function bizClientsHtml(rows, cur, from) {
  const key = r => clientKey(r);
  const first = new Map();
  const life = new Map();
  rows.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(r => {
    const k = key(r);
    if (!first.has(k)) first.set(k, new Date(r.date).getTime());
    const c = life.get(k) || { key: k, name: r.client, phone: r.phone, orders: 0, total: 0, last: 0 };
    c.orders++; c.total += r.total; c.last = Math.max(c.last, new Date(r.date).getTime()); c.name = r.client; c.phone = r.phone;
    life.set(k, c);
  });

  const periodClients = new Map();
  cur.forEach(r => {
    const k = key(r);
    const c = periodClients.get(k) || { key: k, name: r.client, total: 0, orders: 0 };
    c.total += r.total; c.orders++;
    periodClients.set(k, c);
  });
  const all = [...periodClients.values()];
  const fresh = all.filter(c => first.get(c.key) >= from).length;
  const back = all.length - fresh;
  const top = all.sort((a, b) => b.total - a.total).slice(0, 5);
  const topMax = top.length ? top[0].total : 1;

  // Давно не заказывали: постоянные (2+ заказа), последний заказ больше 45 дней назад
  const sleeping = [...life.values()]
    .filter(c => c.orders >= 2 && Date.now() - c.last > 45 * DAY)
    .sort((a, b) => b.total - a.total).slice(0, 5);

  return `
    <div class="section-title">Клиенты</div>
    <div class="tiles">
      <div class="tile neutral kpi"><span class="tile-l">Новые</span><span class="tile-v">${fresh}</span><span class="tile-s">первый заказ в этом периоде</span></div>
      <div class="tile neutral kpi"><span class="tile-l">Вернулись</span><span class="tile-v">${back}</span><span class="tile-s">${all.length ? Math.round(back / all.length * 100) : 0}% клиентов — постоянные</span></div>
    </div>
    ${top.length ? `<div class="card hbars">
      <div class="hint small" style="margin-bottom:4px">Лучшие клиенты за период</div>
      ${top.map(c => `
        <div class="hbar" data-act="openClient" data-key="${esc(c.key)}">
          <div class="row between"><span class="ellipsis">${esc(c.name)}</span><span class="small"><b class="money">${moneyShort(c.total)}</b> <span class="hint">· ${ordersWord(c.orders)}</span></span></div>
          <div class="track"><span style="width:${Math.round(c.total / topMax * 100)}%"></span></div>
        </div>`).join('')}
    </div>` : ''}
    ${sleeping.length ? `
      <div class="section-title">Давно не заказывали</div>
      <div class="list">${sleeping.map(c => {
        const url = waLink(c.phone, fillText(state.texts.comeback || 'Здравствуйте, {client}! Давно не виделись 🙂 Если что-то присмотрели — пишите, выкупим.', { client: c.name, no: '', debt: 0, track: '' }));
        return `
          <div class="lrow">
            <span class="ava" data-act="openClient" data-key="${esc(c.key)}">${esc(initials(c.name))}</span>
            <div class="grow" data-act="openClient" data-key="${esc(c.key)}">
              <div class="l1"><span class="name ellipsis">${esc(c.name)}</span></div>
              <div class="l2">${ordersWord(c.orders)} на ${moneyShort(c.total)} · последний ${daysWord(Math.floor((Date.now() - c.last) / DAY))} назад</div>
            </div>
            ${url ? `<button class="btn small wa" data-act="open" data-url="${esc(url)}">${icon('chat')}Написать</button>` : ''}
          </div>`;
      }).join('')}</div>` : ''}`;
}

// ---------- Магазины ----------

function bizShopsHtml(cur) {
  const map = new Map();
  cur.forEach(r => (r.shops || []).forEach(s => {
    const m = map.get(s) || { name: s, orders: 0, total: 0 };
    m.orders++;
    m.total += r.total / (r.shops.length || 1); // заказ из нескольких магазинов делим поровну
    map.set(s, m);
  }));
  const top = [...map.values()].sort((a, b) => b.orders - a.orders).slice(0, 5);
  if (!top.length) return '';
  const max = top[0].orders;
  return `
    <div class="section-title">Магазины</div>
    <div class="card hbars">
      ${top.map(s => `
        <div class="hbar">
          <div class="row between"><span class="ellipsis"><span class="ava sm">${esc(s.name[0].toUpperCase())}</span>${esc(s.name)}</span>
            <span class="small"><b>${ordersWord(s.orders)}</b> <span class="hint">· ${moneyShort(s.total)}</span></span></div>
          <div class="track"><span style="width:${Math.round(s.orders / max * 100)}%"></span></div>
        </div>`).join('')}
    </div>`;
}

// ---------- Скорость доставки ----------

function bizSpeedHtml(rows, from) {
  const done = rows.filter(r => r.status === state.statuses[S.DONE] && new Date(r.statusAt).getTime() >= from);
  const days = done.map(r => (new Date(r.statusAt) - new Date(r.date)) / DAY).filter(d => d >= 0);
  const avg = days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : 0;
  const t = Object.assign({ way: 25 }, state.settings.attention || {});
  const stuck = state.orders.filter(o => statusIdx(o.status) === S.WAY && daysSince(o.statusAt || o.date) >= t.way).length;
  return `
    <div class="section-title">Доставка</div>
    <div class="tiles">
      <div class="tile neutral kpi"><span class="tile-l">От заказа до выдачи</span><span class="tile-v">${days.length ? daysWord(avg) : '—'}</span><span class="tile-s">в среднем, ${ordersWord(days.length)}</span></div>
      <button class="tile ${stuck ? 'danger' : 'neutral'} kpi" data-act="tile" data-v="going"><span class="tile-l">Застряли в пути</span><span class="tile-v">${stuck}</span><span class="tile-s">дольше ${daysWord(t.way)}</span></button>
    </div>`;
}

// =====================================================================
//  КАЛЬКУЛЯТОР «СКОЛЬКО БУДЕТ СТОИТЬ?»
//  Клиент спрашивает цену — байер вводит цену с сайта и сразу отвечает в WhatsApp
// =====================================================================

function calcNumbers() {
  const t = currentScreen();
  const amount = parseNum(t.amount) || 0;
  const rate = t.cur === '€' ? state.settings.eur : state.settings.usd;
  const markup = t.opt ? state.settings.opt : state.settings.retail;
  const cost = amount * t.qty * rate;
  const price = calcPrice(cost, markup, state.settings.round);
  return { amount, rate, markup, cost, price, profit: price - cost };
}

function calcAnswer() {
  const n = calcNumbers();
  return fillText(state.texts.price || 'Стоимость с доставкой до Казахстана — {price}', {}, { price: money(n.price) });
}

function calcResultHtml() {
  const t = currentScreen();
  const n = calcNumbers();
  if (!n.price) return `<div class="calc-big hint">Введите цену с сайта</div>`;
  return `
    <div class="calc-big money">${money(n.price)}</div>
    <div class="hint small">${fmtNum(n.amount)} ${t.cur}${t.qty > 1 ? ` × ${t.qty}` : ''} × курс ${fmtNum(n.rate)} + ${fmtNum(n.markup)}% · ваша прибыль <b class="ok">${money(n.profit)}</b></div>`;
}

function calcScreen(t) {
  return `
    <div class="card">
      <label class="hint small" for="calcAmount">Цена на сайте${t.qty > 1 ? ' за 1 шт' : ''}</label>
      <div class="fields-row" style="margin-top:6px">
        <div class="field" style="flex:1.6"><input id="calcAmount" class="input calc-input" inputmode="decimal" placeholder="0" value="${esc(t.amount)}" autocomplete="off"></div>
        <div class="field"><div class="seg">
          <button class="${t.cur === '$' ? 'on' : ''}" data-act="calcCur" data-v="$">$</button>
          <button class="${t.cur === '€' ? 'on' : ''}" data-act="calcCur" data-v="€">€</button>
        </div></div>
      </div>
      <div class="fields-row">
        <div class="field"><div class="seg">
          <button class="${t.opt ? '' : 'on'}" data-act="calcOpt" data-v="0">Розница</button>
          <button class="${t.opt ? 'on' : ''}" data-act="calcOpt" data-v="1">Опт</button>
        </div></div>
        <div class="field" style="flex:.8"><div class="stepper">
          <button data-act="calcQty" data-v="-1" aria-label="Меньше">−</button>
          <input value="${t.qty} шт" readonly aria-label="Количество">
          <button data-act="calcQty" data-v="1" aria-label="Больше">+</button>
        </div></div>
      </div>
    </div>
    <div class="card calc-result" id="calcResult">${calcResultHtml()}</div>
    <button class="btn wa" data-act="open" data-url="https://wa.me/?text=${encodeURIComponent(calcAnswer())}" id="calcWa">${icon('chat')}Ответить в WhatsApp</button>
    <div class="btn-row">
      <button class="btn small" data-act="calcCopy">${icon('paste')}Скопировать</button>
      <button class="btn small primary" data-act="calcOrder">${icon('plus')}Оформить заказ</button>
    </div>
    <p class="hint small" style="margin:10px 4px">Курс и наценка — из «Настроек» (последние, с которыми вы оформляли заказ).</p>`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано — вставьте в чат с клиентом');
  } catch (e) {
    prompt('Скопируйте текст:', text);
  }
}

// =====================================================================
//  «ГДЕ МОЙ ЗАКАЗ?» — ссылка для клиента
// =====================================================================

// Страница лежит рядом с приложением: .../track.html?api=...&t=КОД (в демо — ?demo=1&t=КОД)
function trackUrl(token) {
  const base = location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
  return base + 'track.html?' + (DEMO ? 'demo=1' : 'api=' + encodeURIComponent(API_URL)) + '&t=' + token + '&p=' + getLook().palette;
}

async function shareTrackLink(no) {
  const o = findOrder(no);
  if (!o) return;
  if (!o.token) {
    const res = await call('trackLink', { no });
    if (!res) return;
    o.token = res.token;
    saveCacheSoon();
  }
  const text = fillText(state.texts.track || 'Следить за заказом №{no}: {link}', o, { link: trackUrl(o.token) });
  const url = waLink(o.phone, text);
  openSheet('track', `
    <h3>Ссылка для клиента</h3>
    <p class="hint" style="margin-top:-6px">Клиент увидит статус своего заказа, товары и трек-номер — без ваших данных и чужих заказов. Ссылка уже есть в чеке.</p>
    <div class="receipt small" style="word-break:break-all">${esc(trackUrl(o.token))}</div>
    ${url ? `<button class="btn wa" data-act="open" data-url="${esc(url)}" style="margin-top:12px">${icon('chat')}Отправить ${esc(o.client)}</button>` : ''}
    <div class="btn-row">
      <button class="btn small" data-act="open" data-url="${esc(trackUrl(o.token))}">${icon('external')}Посмотреть</button>
      <button class="btn small" data-act="trackCopy" data-text="${esc(text)}">${icon('paste')}Скопировать</button>
    </div>`);
}
ACTIONS.trackCopy = d => copyText(d.text);

// =====================================================================
//  ЗАМЕТКИ О КЛИЕНТЕ: размеры, вкусы, день рождения
// =====================================================================

function noteOf(key) { return (state.notes || {})[key] || { note: '', birthday: '' }; }

function noteFor(name, phone) {
  if (!name && !phone) return '';
  return noteOf(clientKey({ client: name || '', phone: phone || '' })).note;
}

function clientNoteHtml(key, c) {
  const n = noteOf(key);
  const bd = n.birthday ? birthdayIn(n.birthday) : null;
  return `
    <div class="card note-card" data-act="noteSheet" data-key="${esc(key)}" data-name="${esc(c.name)}" data-phone="${esc(c.phone)}">
      <div class="row between"><b>${icon('note')} Заметки</b><span class="link-btn" style="padding:0">${n.note || n.birthday ? 'Изменить' : 'Добавить'}</span></div>
      ${n.note ? `<div class="note-text">${esc(n.note)}</div>` : `<div class="hint small">Размеры, любимые бренды, что не нравится — чтобы не спрашивать каждый раз</div>`}
      ${n.birthday ? `<div class="small" style="margin-top:6px">${icon('cake')} День рождения ${esc(n.birthday)}${bd === 0 ? ' — <b class="ok">сегодня!</b>' : bd !== null && bd <= 7 ? ` — через ${daysWord(bd)}` : ''}</div>` : ''}
    </div>`;
}

function openNoteSheet(key, name, phone) {
  const n = noteOf(key);
  openSheet('note', `
    <h3>Заметки · ${esc(name)}</h3>
    <textarea id="noteText" class="input" placeholder="Например: обувь 38, одежда M, любит бежевый, не любит синее">${esc(n.note)}</textarea>
    <label class="hint small" for="noteBd" style="display:block;margin:10px 2px 4px">День рождения (дд.мм) — приложение напомнит поздравить</label>
    <input id="noteBd" class="input" inputmode="numeric" placeholder="14.03" value="${esc(n.birthday)}" autocomplete="off">
    <button class="btn primary" data-act="noteSave" data-key="${esc(key)}" data-name="${esc(name)}" data-phone="${esc(phone)}" style="margin-top:10px">Сохранить</button>`);
  setTimeout(() => $('#noteText') && $('#noteText').focus(), 100);
}

function saveNote(key, name, phone) {
  const note = ($('#noteText').value || '').trim();
  let birthday = ($('#noteBd').value || '').trim().replace(/[\/,\-\s]/g, '.');
  if (birthday) {
    const m = birthday.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (!m || +m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12) { $('#noteBd').classList.add('bad'); toast('День рождения — в виде дд.мм, например 14.03', true); return; }
    birthday = m[1].padStart(2, '0') + '.' + m[2].padStart(2, '0');
  }
  const before = state.notes[key];
  state.notes = Object.assign({}, state.notes, { [key]: { note, birthday } });
  closeSheet(false);
  render();
  toast('Заметка сохранена');
  saveCacheSoon();
  queueSync('saveNote', { key, name, phone, note, birthday }, () => { state.notes[key] = before; });
}

// Через сколько дней день рождения (0 — сегодня)
function birthdayIn(ddmm) {
  const [d, m] = ddmm.split('.').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), m - 1, d);
  if (next < today) next = new Date(now.getFullYear() + 1, m - 1, d);
  return Math.round((next - today) / 86400000);
}

function birthdaysHtml() {
  const clients = groupByClient(state.orders);
  const list = Object.keys(state.notes || {}).map(key => {
    const n = state.notes[key];
    if (!n.birthday) return null;
    const days = birthdayIn(n.birthday);
    if (days > 7) return null;
    const c = clients.find(x => x.key === key) || (state.clients || []).map(x => ({ key: clientKey({ client: x.name, phone: x.phone }), ...x })).find(x => x.key === key);
    return c ? { key, name: c.name, phone: c.phone, days } : null;
  }).filter(Boolean).sort((a, b) => a.days - b.days);
  if (!list.length) return '';
  return `
    <div class="section-title">Дни рождения</div>
    <div class="list">${list.map(b => {
      const url = waLink(b.phone, fillText(state.texts.birthday || '{client}, с днём рождения! 🎂', { client: b.name.split(' ')[0], no: '', debt: 0, track: '' }));
      return `
        <div class="lrow">
          <span class="ava">${icon('cake')}</span>
          <div class="grow" data-act="openClient" data-key="${esc(b.key)}">
            <div class="l1"><span class="name ellipsis">${esc(b.name)}</span></div>
            <div class="l2">${b.days === 0 ? '<b class="ok">сегодня</b>' : b.days === 1 ? 'завтра' : `через ${daysWord(b.days)}`}</div>
          </div>
          ${url && b.days === 0 ? `<button class="btn small wa" data-act="open" data-url="${esc(url)}">${icon('chat')}Поздравить</button>` : ''}
        </div>`;
    }).join('')}</div>`;
}

// =====================================================================
//  «НАПОМНИ МНЕ» — бот пришлёт сообщение в нужное время
// =====================================================================

function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openReminderSheet(no, key, name) {
  const o = no ? findOrder(no) : null;
  const who = o ? `№${o.no} ${o.client}` : name;
  const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.getTime(); };
  const now = new Date();
  const options = [
    ['Через час', Date.now() + 3600000],
    [now.getHours() < 19 ? 'Сегодня в 20:00' : 'Завтра в 20:00', now.getHours() < 19 ? at(0, 20) : at(1, 20)],
    ['Завтра в 10:00', at(1, 10)],
    ['Через 3 дня', at(3, 10)],
  ];
  openSheet('reminder', `
    <h3>Напомнить мне</h3>
    <input id="remText" class="input" value="${esc(who ? who + ': ' : '')}" placeholder="О чём напомнить" autocomplete="off">
    <div class="chips wrap-chips" style="margin-top:10px">${options.map(([label, t], i) =>
      `<button class="chip ${i === 2 ? 'on' : ''}" data-act="reminderWhen" data-v="${t}">${label}</button>`).join('')}</div>
    <input id="remWhen" class="input" type="datetime-local" value="${toLocalInput(new Date(options[2][1]))}" style="margin-top:4px">
    <button class="btn primary" data-act="reminderSave" data-no="${no || ''}" data-key="${esc(key)}" style="margin-top:10px">${icon('bell')}Напомнить</button>
    <p class="hint small" style="margin:8px 2px 0">Бот пришлёт сообщение в это время${o ? ' с кнопкой «Открыть заказ»' : ''}.</p>`);
  setTimeout(() => { const el = $('#remText'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 100);
}

function saveReminder(no, key) {
  const text = ($('#remText').value || '').trim();
  const when = new Date($('#remWhen').value);
  if (!text) {
    $('#remText').classList.add('bad');
    toast('Напишите, о чём напомнить', true);
    return;
  }
  if (isNaN(when) || when < Date.now() - 60000) { $('#remWhen').classList.add('bad'); toast('Выберите время в будущем', true); return; }
  const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), when: when.toISOString(), text, no, key };
  state.reminders = (state.reminders || []).concat(r);
  closeSheet(false);
  render();
  haptic('success');
  toast(`Напомню ${when.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` + (DEMO ? ' (в демо бот не пишет)' : ''));
  saveCacheSoon();
  queueSync('addReminder', { reminder: r }, () => { state.reminders = state.reminders.filter(x => x.id !== r.id); });
}

function deleteReminder(id) {
  const r = (state.reminders || []).find(x => x.id === id);
  if (!r) return;
  state.reminders = state.reminders.filter(x => x.id !== id);
  render();
  saveCacheSoon();
  queueSync('deleteReminder', { id }, () => { state.reminders = state.reminders.concat(r); });
}

function remindersTodayHtml() {
  const list = (state.reminders || []).slice().sort((a, b) => new Date(a.when) - new Date(b.when)).slice(0, 5);
  if (!list.length) return '';
  return `
    <div class="section-title">Мои напоминания</div>
    <div class="list">${list.map(r => {
      const due = new Date(r.when) <= Date.now();
      return `
        <div class="lrow ${due ? 'due' : ''}">
          <span class="ava">${icon('bell')}</span>
          <div class="grow" ${r.no ? `data-act="openOrder" data-no="${r.no}"` : r.key ? `data-act="openClient" data-key="${esc(r.key)}"` : ''}>
            <div class="l1"><span class="name ellipsis">${esc(r.text)}</span></div>
            <div class="l2">${due ? '<b class="warn-text">пора</b> · ' : ''}${new Date(r.when).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          <button class="icon-btn soft del-btn" data-act="reminderDelete" data-id="${esc(r.id)}" aria-label="${due ? 'Готово' : 'Удалить'}">${due ? '✓' : '✕'}</button>
        </div>`;
    }).join('')}</div>`;
}

// =====================================================================
//  НАСТРОЙКИ — всё, что байер меняет под себя, без Google-таблицы
// =====================================================================

const TEXT_INFO = {
  paid: ['Оплата получена', '{client} {no}'],
  bought: ['Заказ выкуплен', '{client} {no}'],
  stock: ['Заказ на складе', '{client} {no}'],
  way: ['Заказ в пути', '{client} {no} {track_line}'],
  arrived: ['Заказ прибыл', '{client} {no} {debt_line}'],
  done: ['Заказ выдан — спасибо', '{client} {no}'],
  remind: ['Напоминание об оплате', '{client} {no} {debt}'],
  payment: ['Реквизиты для оплаты', '{details} {debt}'],
  price: ['Ответ «Сколько стоит?»', '{price}'],
  track: ['Ссылка «Где мой заказ?»', '{no} {link}'],
  comeback: ['Давно не заказывал', '{client}'],
  birthday: ['С днём рождения', '{client}'],
};

// Пример текста на выдуманном заказе — чтобы было видно, что получит клиент
function sampleText(tpl) {
  const o = { client: 'Алия', no: 125, debt: 12000, track: 'DM123456789US' };
  return fillText(tpl, o, { price: money(57900), link: 'https://…/track.html', details: state.settings.paymentDetails || 'Kaspi +7 7…' });
}

function settingsScreen(t) {
  const f = t.form;
  const field = (key, label, attrs = '', hint = '') => `
    <div class="field"><label>${label}</label>
      <input class="input" data-sf="${key}" value="${esc(f[key])}" ${attrs} autocomplete="off">
      ${hint ? `<div class="hint small" style="margin:4px 2px 0">${hint}</div>` : ''}</div>`;
  const days = (key, label) => `
    <div class="field"><label>${label}</label>
      <input class="input" data-sa="${key}" inputmode="numeric" value="${esc(f.attention[key])}"></div>`;
  const keys = Object.keys(TEXT_INFO).filter(k => f.texts[k] !== undefined || (state.defaultTexts || {})[k]);

  const look = getLook();
  return `
    <div class="section-title">Оформление</div>
    <div class="card">
      <div class="swatches">${PALETTES.map(([id, name, color]) => `
        <button class="swatch ${look.palette === id ? 'on' : ''}" data-act="lookPalette" data-v="${id}"><i style="background:${color}"></i>${name}</button>`).join('')}</div>
      <div class="seg" style="margin-top:12px">
        <button class="${look.density === 'cozy' ? 'on' : ''}" data-act="lookDensity" data-v="cozy">Просторно</button>
        <button class="${look.density === 'compact' ? 'on' : ''}" data-act="lookDensity" data-v="compact">Компактно</button>
      </div>
      <div class="hint small" style="margin-top:8px">Меняется сразу и только на этом телефоне.</div>
    </div>

    <div class="section-title">Магазин</div>
    <div class="card">
      ${field('shopName', 'Название магазина', 'placeholder="Например, Aliya Shop"', 'Показывается в чеке и на странице «Где мой заказ?»')}
      ${field('paymentDetails', 'Реквизиты для оплаты', 'placeholder="Kaspi Gold +7 701 000 00 00 (Алия С.)"', 'Отправляются клиенту кнопкой «Отправить реквизиты»')}
    </div>

    <div class="section-title">Цены</div>
    <div class="card">
      <div class="fields-row">
        ${field('retail', 'Наценка розница, %', 'inputmode="decimal"')}
        ${field('opt', 'Наценка опт, %', 'inputmode="decimal"')}
      </div>
      <div class="fields-row">
        ${field('usd', 'Курс $, ₸', 'inputmode="decimal"')}
        ${field('eur', 'Курс €, ₸', 'inputmode="decimal"')}
        ${field('round', 'Шаг цены, ₸', 'inputmode="numeric"')}
      </div>
      <div class="hint small">Курс меняется и сам — каждый раз, когда вы оформляете заказ с новым курсом.</div>
    </div>

    <div class="section-title">Деньги</div>
    <div class="card">
      <div class="fields-row">
        ${field('goal', 'Цель на месяц, ₸', 'inputmode="numeric" placeholder="5 000 000"')}
        ${field('taxRate', 'Налог, % от выручки', 'inputmode="decimal"')}
      </div>
      <div class="hint small">Налог нужен для «Можно взять себе». Свою ставку уточните у бухгалтера.</div>
    </div>

    <div class="section-title">«Требует внимания» — через сколько дней</div>
    <div class="card">
      <div class="fields-row">${days('wait', 'Не оплачен')}${days('paid', 'Не выкуплен')}</div>
      <div class="fields-row">${days('way', 'Долго в пути')}${days('arrived', 'Не забирают')}</div>
    </div>

    <div class="section-title">Сообщения клиентам</div>
    <p class="hint small" style="margin:-2px 4px 8px">Пишите своими словами. Вместо слов в фигурных скобках подставится: {client} — имя, {no} — номер заказа, {debt} — долг, {price} — цена, {link} — ссылка, {details} — реквизиты, {track_line} — строка с трек-номером, {debt_line} — строка с доплатой.</p>
    <div class="list">
      ${keys.map(k => {
        const [label, ph] = TEXT_INFO[k];
        const open = t.open === k;
        const changed = (state.defaultTexts || {})[k] && f.texts[k] !== state.defaultTexts[k];
        return `
          <div class="text-item ${open ? 'open' : ''}">
            <div class="lrow" data-act="textOpen" data-k="${k}">
              <div class="grow">
                <div class="l1"><span class="name">${esc(label)}</span>${changed ? '<span class="pill sm" style="--c:var(--btn);--cbg:color-mix(in srgb,var(--btn) 15%,transparent)">свой</span>' : ''}</div>
                ${open ? '' : `<div class="l2 ellipsis">${esc(f.texts[k] || '')}</div>`}
              </div>
              <span class="chev ${open ? 'open' : ''}">${icon('chevron')}</span>
            </div>
            ${open ? `<div class="text-edit">
              <textarea class="input" data-st="${k}">${esc(f.texts[k] || '')}</textarea>
              <div class="hint small">Можно использовать: ${esc(ph)}</div>
              <div class="example"><span class="hint small">Клиент получит:</span><div id="ex-${k}">${esc(sampleText(f.texts[k] || ''))}</div></div>
              ${changed ? `<button class="link-btn" data-act="textReset" data-k="${k}">Вернуть как было</button>` : ''}
            </div>` : ''}
          </div>`;
      }).join('')}
    </div>

    <button class="btn primary" data-act="settingsSave" style="margin-top:16px">Сохранить настройки</button>
    <p class="hint small" style="margin:10px 4px">Всё хранится в вашей Google-таблице (листы «Настройки» и «Тексты») — там это тоже можно поменять.</p>`;
}

function saveSettings() {
  const t = currentScreen();
  const f = t.form;
  const num = (v, min, max) => Math.min(max, Math.max(min, parseNum(v) || 0));
  const settings = {
    shopName: String(f.shopName).trim(), paymentDetails: String(f.paymentDetails).trim(),
    retail: num(f.retail, 0, 1000), opt: num(f.opt, 0, 1000), round: num(f.round, 1, 100000) || 1,
    usd: num(f.usd, 0, 100000), eur: num(f.eur, 0, 100000),
    goal: Math.round(num(f.goal, 0, 1e12)), taxRate: num(f.taxRate, 0, 100),
    attention: {
      wait: num(f.attention.wait, 1, 365) || 3, paid: num(f.attention.paid, 1, 365) || 3,
      way: num(f.attention.way, 1, 365) || 25, arrived: num(f.attention.arrived, 1, 365) || 5,
    },
  };
  if (!(settings.usd > 0) || !(settings.eur > 0)) { toast('Укажите курс $ и €', true); return; }
  // Отправляем только изменённые тексты
  const texts = {};
  Object.keys(f.texts).forEach(k => { if (f.texts[k] !== state.texts[k]) texts[k] = f.texts[k]; });

  const before = { settings: state.settings, texts: state.texts };
  state.settings = Object.assign({}, state.settings, settings);
  state.texts = Object.assign({}, state.texts);
  Object.keys(texts).forEach(k => { state.texts[k] = String(texts[k]).trim() || (state.defaultTexts || {})[k] || ''; });
  t.dirty = false;
  state.stack.pop();
  render();
  haptic('success');
  toast('Настройки сохранены');
  saveCacheSoon();
  queueSync('saveSettings', { settings, texts }, () => { state.settings = before.settings; state.texts = before.texts; });
}

// =====================================================================
//  ВКЛАДКА «КЛИЕНТЫ»
// =====================================================================

function clientsTab() {
  return `
    <div class="search-wrap">${icon('search')}
      <input id="csearch" class="input search" type="search" placeholder="Имя или телефон" value="${esc(state.cquery)}" autocomplete="off">
    </div>
    <div id="clientList">${clientsListHtml()}</div>`;
}

function clientsListHtml() {
  const q = state.cquery.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const list = groupByClient(state.orders).filter(c => !q ||
    c.name.toLowerCase().includes(q) || (digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits)));
  if (!list.length) return emptyHtml('🤷', 'Никого не нашли', 'Попробуйте часть имени или последние 4 цифры телефона');
  const shown = list.slice(0, state.limit);
  const rest = list.length - shown.length;
  return `<p class="hint" style="margin:0 4px 8px">${list.length} клиентов · свежие сверху</p>
    <div class="list">${shown.map(clientRow).join('')}</div>` +
    (rest > 0 ? `<button class="btn" data-act="moreClients">Показать ещё ${Math.min(rest, PAGE)} из ${rest}</button>` : '');
}

// =====================================================================
//  ТЕКСТЫ ДЛЯ КЛИЕНТА И WHATSAPP
// =====================================================================

function fillText(tpl, o, extra) {
  if (!tpl) return '';
  Object.keys(extra || {}).forEach(k => { tpl = tpl.split('{' + k + '}').join(extra[k]); });
  return tpl
    .replace(/\{client\}/g, o.client)
    .replace(/\{no\}/g, o.no)
    .replace(/\{shop\}/g, state.settings.shopName || '')
    .replace(/\{debt\}/g, money(o.debt))
    .replace(/\{track_line\}/g, o.track ? `\nТрек-номер: ${o.track}` : '')
    .replace(/\{debt_line\}/g, o.debt > 0 ? `\nК доплате: ${money(o.debt)}` : '');
}

function statusMessage(o) {
  const key = TEXT_KEYS[statusIdx(o.status)];
  return key ? fillText(state.texts[key], o) : '';
}

// Чек — обычный текст, чтобы одинаково выглядел в WhatsApp
function receiptText(o) {
  const lines = [];
  if (state.settings.shopName) lines.push(state.settings.shopName);
  lines.push(`🧾 Заказ №${o.no || '…'}`, o.client, '');
  o.items.forEach((x, i) => lines.push(`${i + 1}. ${itemLabel(x)} — ${money(x.price)}`));
  lines.push('', `Итого: ${money(o.total)}`, `Оплачено: ${money(o.paid)}`);
  if (o.debt > 0) lines.push(`Осталось оплатить: ${money(o.debt)}`);
  if (o.token) lines.push('', `Следить за заказом: ${trackUrl(o.token)}`);
  return lines.join('\n');
}

// Ссылка wa.me открывает чат с клиентом и готовым текстом. 87071234567 → 77071234567
function waLink(phone, text) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (d.length < 11) return null;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

function openLink(url) {
  if (!url) return;
  if (IN_TG) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

// =====================================================================
//  МЕЛОЧИ
// =====================================================================

function findOrder(no) { return state.orders.find(o => o.no === Number(no)); }
function statusIdx(name) { return state.statuses.indexOf(name); }
function isClosed(o) { const i = statusIdx(o.status); return i === S.DONE || i === S.CANCEL; }
function isCancelled(o) { return statusIdx(o.status) === S.CANCEL; }

function statusStyle(i) {
  const c = STATUS_COLORS[i] || '#8b8d98';
  return `--c:${c};--cbg:${c}2e`;
}

function pill(status) {
  return `<span class="pill" style="${statusStyle(statusIdx(status))}">${esc(status)}</span>`;
}

// Цена клиенту: себестоимость × (1 + наценка), округлённая ВВЕРХ до шага (например, до 100 ₸)
function calcPrice(cost, markup, round) {
  if (!(cost > 0)) return 0;
  const step = Math.max(1, Number(round) || 1);
  return Math.ceil(cost * (1 + markup / 100) / step - 1e-9) * step;
}

function parseNum(t) {
  const m = String(t == null ? '' : t).replace(/\s/g, '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// 12500 → «12 500 ₸»
function money(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '−' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';
}

// 1 заказ, 3 заказа, 5 заказов
function ordersWord(n) {
  const d = n % 10, h = n % 100;
  const w = d === 1 && h !== 11 ? 'заказ' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'заказа' : 'заказов';
  return `${n} ${w}`;
}

// Большие суммы коротко: 1 234 000 → «1,2 млн ₸»
function moneyShort(n) {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) < 1e6) return money(v);
  return String(Math.round(v / 1e5) / 10).replace('.', ',') + ' млн ₸';
}

// Иконки — простые линии (SVG), одинаково выглядят на всех телефонах, в отличие от эмодзи
const ICONS = {
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H6"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2M6 6V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  truck: '<path d="M3 6h11v11H3zM14 10h4l3 3.5V17h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  gift: '<path d="M20 12v8H4v-8M2 7h20v5H2zM12 22V7M12 7H8a2.5 2.5 0 1 1 0-5c3 0 4 5 4 5zM12 7h4a2.5 2.5 0 1 0 0-5c-3 0-4 5-4 5z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  chat: '<path d="M3 21l1.6-4.6A8.5 8.5 0 1 1 8 19.8L3 21z"/><path d="M9 10.5c.5 1.6 1.9 3 3.5 3.5l1.2-1.2 2 .8v1.6c-3.5.3-7.5-3.7-7.2-7.2H10l.8 2-1.3 1.2"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6M9 16h3"/>',
  paste: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
  checks: '<path d="M4 12l4 4 8-8M14 16l1 1 6-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15v3M8 18h.01M12 18h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2 2 0 0 0 4 0"/>',
  note: '<path d="M5 4h14v12l-4 4H5zM15 20v-4h4M8 8h8M8 12h5"/>',
  cake: '<path d="M4 21h16M5 21v-8h14v8M4 17c2 1 3 0 4-1 1 1 3 2 4 0 1 2 3 1 4 0 1 1 2 2 4 1M12 13V9M12 6.5c-1-1 0-2.5 0-2.5s1 1.5 0 2.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h4.5l1 2h5l1-2H20"/>',
  offline: '<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.5-2.8M19 13a10 10 0 0 0-2.4-1.7M2 9.5a15 15 0 0 1 4.3-2.6M22 9.5A15 15 0 0 0 11 5.6"/><path d="M12 20h.01"/>',
};

// «Алия С.» → «АС» — для кружка-аватарки
function initials(name) {
  const parts = String(name).replace(/[«»"]/g, '').split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function fmtNum(n) {
  return String(Math.round((Number(n) || 0) * 100) / 100).replace('.', ',');
}

function fmtDate(iso, withYear) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}` + (withYear ? `.${d.getFullYear()}` : '');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isUrl(s) { return /^https?:\/\//i.test(String(s)); }

// northwear-demo.com из ссылки; если прислали не ссылку, а описание — «Без ссылки»
function site(link) {
  const m = String(link).match(/https?:\/\/(?:www\.)?([^\/\s?#]+)/i);
  return m ? m[1] : 'Без ссылки';
}

// Понятное название из ссылки: .../p/denim-jacket-1042 → «denim jacket 1042»
function productName(link) {
  if (!isUrl(link)) return link || 'Товар';
  const path = String(link).split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  const name = decodeURIComponentSafe(path).replace(/\.\w+$/, '').replace(/[-_]+/g, ' ').trim();
  return name && !/^www\./.test(name) ? name : site(link);
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function itemLabel(x) {
  const label = [isUrl(x.link) ? site(x.link) : x.link, x.size].filter(Boolean).join(' · ') || 'Товар';
  return x.qty > 1 ? `${label} × ${x.qty}` : label;
}

let toastTimer = null;
// Короткое уведомление. withUndo — показать кнопку «Отменить» (5 секунд)
function toast(text, isError, withUndo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>` + (withUndo ? `<button class="undo" data-act="undo">Отменить</button>` : '');
  el.classList.toggle('err', !!isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, withUndo ? 5000 : isError ? 3500 : 2200);
}

function hideToast() {
  $('#toast').hidden = true;
  undoSnap = null;
}

// Лёгкая вибрация телефона (работает только в Telegram)
function haptic(type) {
  if (!IN_TG || !tg.HapticFeedback) return;
  try {
    if (type === 'light') tg.HapticFeedback.impactOccurred('light');
    else tg.HapticFeedback.notificationOccurred(type);
  } catch (e) { /* старые версии Telegram */ }
}

start();
