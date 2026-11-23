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
  sort: 'new',        // сортировка заказов: new — новые, debt — с долгом, old — дольше ждут
  attnKind: 'all',    // фильтр «Требует внимания» на главном экране
  cseg: 'all',        // группа во вкладке «Клиенты»
  csort: 'recent',    // сортировка клиентов
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

// Пока открыта клавиатура (курсор в поле) — прячем нижнее меню, итог и главную кнопку,
// чтобы на маленьком экране было видно, что вводишь
let typingTimer = null;
function isTypingField(el) {
  return el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'date', 'datetime-local'].includes(el.type)));
}
function onFocusIn(e) {
  if (!isTypingField(e.target)) return;
  clearTimeout(typingTimer);
  document.body.classList.add('typing');
  if (IN_TG) { try { tg.MainButton.hide(); } catch (err) { /* старые версии */ } }
  // Поле — повыше, ближе к верху экрана, чтобы подсказки под ним тоже были видны
  setTimeout(() => { if (document.activeElement === e.target) e.target.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 250);
}
function onFocusOut() {
  // Небольшая пауза: при переходе между полями клавиатура не закрывается — меню не мигает
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    if (isTypingField(document.activeElement)) return;
    document.body.classList.remove('typing');
    updateMainButton();
  }, 150);
}

function start() {
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('scroll', e => {
    if (!e.target || e.target.id !== 'hvCards') return;
    const c = e.target, i = Math.round(c.scrollLeft / ((c.firstElementChild ? c.firstElementChild.offsetWidth : 1) + 10));
    document.querySelectorAll('#hvDots i').forEach((d, k) => d.classList.toggle('on', k === i));
  }, true);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: true });
  document.addEventListener('touchend', onTouchEnd);
  document.addEventListener('touchcancel', onTouchEnd);
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
  document.body.classList.toggle('home', !top && state.tab === 'today' && !state.loading && !state.error);
  $('#title').textContent = top ? screenTitle(top) : state.tab === 'today' ? greetingTitle() : TAB_TITLES[state.tab];
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
    if (text && !document.body.classList.contains('typing')) { tg.MainButton.setText(text); tg.MainButton.show(); } else tg.MainButton.hide();
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

// Смахивание строки заказа: вправо — следующий статус, влево — WhatsApp клиенту
let swipe = null;
let suppressClick = 0;

function onTouchStart(e) {
  const row = e.target.closest('[data-swipe]');
  swipe = row && e.touches.length === 1 ? { row, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, active: false } : null;
}

function onTouchMove(e) {
  if (!swipe) return;
  const t = e.touches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (Math.abs(dx) < 14) return;
    swipe.active = true;
    swipe.row.classList.add('swiping');
  }
  swipe.dx = Math.max(-110, Math.min(110, dx));
  swipe.row.style.transform = `translateX(${swipe.dx}px)`;
  const list = swipe.row.parentElement;
  list.classList.toggle('sw-next', swipe.dx > 0);
  list.classList.toggle('sw-wa', swipe.dx < 0);
  const armed = Math.abs(swipe.dx) >= 80;
  if (armed && !swipe.row.classList.contains('armed')) haptic('light');
  swipe.row.classList.toggle('armed', armed);
}

function onTouchEnd() {
  if (!swipe) return;
  const { row, dx, active } = swipe;
  swipe = null;
  if (!active) return;
  suppressClick = Date.now();
  row.classList.remove('swiping', 'armed');
  row.style.transform = '';
  row.parentElement.classList.remove('sw-next', 'sw-wa');
  if (Math.abs(dx) < 80) return;
  const o = findOrder(Number(row.dataset.no));
  if (!o) return;
  try { localStorage.setItem('buyercrm-swiped', '1'); } catch (e) { /* не страшно */ }
  if (dx > 0) {
    const i = statusIdx(o.status);
    if (i >= 0 && i < S.DONE) askStatus([o.no], i + 1);
    else toast('Заказ уже завершён');
  } else {
    const url = waLink(o.phone, statusMessage(o) || '');
    if (url) openLink(url); else toast('У клиента нет телефона', true);
  }
}

function onClick(e) {
  if (Date.now() - suppressClick < 400) { e.preventDefault(); return; }
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
  filter: d => { state.filter = ['active', 'all', 'going', 'debt'].includes(d.v) ? d.v : Number(d.v); state.limit = PAGE; render(); },
  sort: () => {
    const keys = Object.keys(ORDER_SORTS);
    state.sort = keys[(keys.indexOf(state.sort) + 1) % keys.length];
    state.limit = PAGE;
    render();
  },
  attnKind: d => { state.attnKind = d.v; render(); },
  goSearch: () => {
    switchTab('orders');
    const el = $('#search');
    if (el) el.focus();
  },
  cseg: d => { state.cseg = d.v; state.limit = PAGE; render(); },
  csort: () => {
    const keys = Object.keys(CLIENT_SORTS);
    state.csort = keys[(keys.indexOf(state.csort) + 1) % keys.length];
    render();
  },
  quickToggle: () => {
    const d = state.draft;
    d.quickOpen = !d.quickOpen;
    if (d.quickOpen) d.pasteOpen = false;
    saveDraft();
    render();
    if (d.quickOpen) $('[data-f="quickText"]').focus();
  },
  quickApply: () => applyQuick(),
  ratesToggle: () => { state.draft.ratesOpen = !state.draft.ratesOpen; saveDraft(); render(); },
  payMethod: d => { const dr = state.draft; dr.payMethod = dr.payMethod === d.v ? '' : d.v; saveDraft(); render(); },
  discountPct: d => {
    const c = calcDraft();
    const step = Math.max(1, Number(state.settings.round) || 1);
    state.draft.discount = String(Math.round(c.itemsTotal * Number(d.v) / 100 / step) * step);
    saveDraft();
    render();
  },
  sizePick: d => { state.draft.items[Number(d.i)].size = d.v; saveDraft(); render(); },
  repeatLast: d => {
    const prev = findOrder(Number(d.no));
    if (!prev) return;
    const dr = state.draft;
    dr.opt = prev.opt;
    if (!dr.markupTouched) dr.markup = String(prev.opt ? state.settings.opt : state.settings.retail);
    dr.items = prev.items.map(x => ({ link: x.link, size: x.size, qty: String(x.qty), amount: String(x.amount), currency: x.currency }));
    saveDraft();
    render();
    toast(`Товары из заказа №${prev.no} — проверьте цены`);
  },
  addToOrder: d => { state.draft.addTo = Number(d.no); saveDraft(); render(); },
  addToCancel: () => { state.draft.addTo = null; state.draft.dupHidden = true; saveDraft(); render(); },
  dupHide: () => { state.draft.dupHidden = true; saveDraft(); render(); },
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
  reminderDone: d => deleteReminder(d.id),
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
  pasteToggle: () => {
    const d = state.draft;
    d.pasteOpen = !d.pasteOpen;
    if (d.pasteOpen) d.quickOpen = false;
    render();
    if (d.pasteOpen) $('[data-f="pasteText"]').focus();
  },
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
    d.picked = false; d.client = ''; d.phone = ''; d.who = ''; d.instagram = '';
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
  if (f !== 'pasteText' && f !== 'quickText') updateTotals();
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

const ORDER_SORTS = { new: 'Новые', debt: 'С долгом', old: 'Дольше ждут' };

function ordersTab() {
  if (!state.orders.length) {
    return emptyHtml('📭', 'Заказов пока нет', 'Нажмите «+» внизу, чтобы добавить первый');
  }
  const chip = (v, label) => {
    const n = state.orders.filter(o => matchFilter(o, v)).length;
    if (!n && String(state.filter) !== String(v)) return '';
    return `<button class="chip ${String(state.filter) === String(v) ? 'on' : ''}" data-act="filter" data-v="${v}">${label}<span class="n">${n}</span></button>`;
  };
  const visible = filteredOrders().map(o => o.no);
  const allSel = visible.length && visible.every(n => state.selected.includes(n));
  const toolbar = state.selecting
    ? `<button class="link-btn" data-act="selectAll">${allSel ? 'Снять все' : `Выбрать все (${visible.length})`}</button>
       <button class="link-btn" data-act="selectMode">Отмена</button>`
    : `<button class="link-btn" data-act="sort">${icon('sort')}${ORDER_SORTS[state.sort]}</button>
       <button class="link-btn" data-act="selectMode">${icon('checks')}Выбрать</button>`;

  return `
    <div class="search-wrap">${icon('search')}
      <input id="search" class="input search" type="search" placeholder="Имя, телефон, № или трек" value="${esc(state.query)}" autocomplete="off">
    </div>
    <div class="chips">
      ${chip('active', 'В работе')}${chip(S.PAID, 'Выкупить')}${chip('going', 'Едут')}${chip(S.ARRIVED, 'Выдать')}
      ${chip('debt', 'Долги')}${chip(S.WAIT, 'Ждут оплаты')}${chip(S.DONE, 'Выданы')}${chip(S.CANCEL, 'Отменены')}${chip('all', 'Все')}
    </div>
    <div class="toolbar">${toolbar}</div>
    <div id="orderList">${orderListHtml()}</div>`;
}

// Статусы «едут»: выкуплен, на складе, в пути
const GOING = [S.BOUGHT, S.STOCK, S.WAY];

function matchFilter(o, f) {
  if (f === 'active') return !isClosed(o);
  if (f === 'all') return true;
  if (f === 'going') return GOING.includes(statusIdx(o.status));
  if (f === 'debt') return o.debt > 0 && !isCancelled(o);
  return statusIdx(o.status) === Number(f);
}

function filteredOrders() {
  const q = state.query.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const track = normTrack(q);
  const sorters = {
    new: (a, b) => b.no - a.no,
    debt: (a, b) => (b.debt > 0 ? b.debt : 0) - (a.debt > 0 ? a.debt : 0) || b.no - a.no,
    old: (a, b) => (isClosed(a) - isClosed(b)) || new Date(a.statusAt || a.date) - new Date(b.statusAt || b.date),
  };
  return state.orders
    .filter(o => matchFilter(o, state.filter))
    .filter(o => !q ||
      o.client.toLowerCase().includes(q) ||
      String(o.no) === q.replace('№', '') ||
      (digits.length >= 3 && o.phone.replace(/\D/g, '').includes(digits)) ||
      (track.length >= 4 && normTrack(o.track).includes(track)) ||
      (q.length >= 3 && !!o.instagram && o.instagram.includes(q.replace(/^@/, ''))))
    .sort(sorters[state.sort] || sorters.new);
}

// «Сегодня», «Вчера», «среда», «12.11» — заголовки групп в списке заказов
function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  if (diff < 7) { const w = d.toLocaleDateString('ru-RU', { weekday: 'long' }); return w[0].toUpperCase() + w.slice(1); }
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function orderListHtml() {
  const list = filteredOrders();
  const archiveHint = state.archived && (state.filter === 'all' || state.filter === S.DONE || state.filter === S.CANCEL || state.query)
    ? `<p class="hint center">Старые выданные заказы без долга (${state.archived}) не загружаются, чтобы приложение открывалось быстро. Найдите их поиском.</p>` : '';
  if (!list.length) {
    return (state.query ? emptyHtml('🤷', 'Ничего не найдено', 'Попробуйте часть имени, последние 4 цифры телефона или трек-номер')
      : emptyHtml('🎉', 'Здесь пусто', 'Таких заказов нет')) + archiveHint;
  }
  if (state.mode === 'clients') {
    const rows = groupByClient(list);
    const shown = rows.slice(0, state.limit);
    return `<div class="list">${shown.map(clientRow).join('')}</div>` + archiveHint;
  }
  // Итог по тому, что сейчас в списке
  const total = list.reduce((a, o) => a + (isCancelled(o) ? 0 : o.total), 0);
  const debt = list.reduce((a, o) => a + (o.debt > 0 && !isCancelled(o) ? o.debt : 0), 0);
  const strip = `
    <div class="card sumstrip">
      <div><span class="hint small">${ordersWord(list.length)}</span><b class="money">${moneyShort(total)}</b></div>
      <div class="r"><span class="hint small">не оплачено</span><b class="money ${debt ? 'debt' : ''}">${debt ? moneyShort(debt) : 'всё оплачено'}</b></div>
    </div>`;

  const shown = list.slice(0, state.limit);
  const rest = list.length - shown.length;
  let body;
  if (state.sort === 'new') {
    // Группы по дням: «Сегодня», «Вчера», …
    const groups = [];
    shown.forEach(o => {
      const label = dayLabel(o.date);
      if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, list: [] });
      groups[groups.length - 1].list.push(o);
    });
    body = groups.map(g => `<div class="gh">${esc(g.label)}</div><div class="list">${g.list.map(orderRow).join('')}</div>`).join('');
  } else {
    body = `<div class="list">${shown.map(orderRow).join('')}</div>`;
  }
  let swipeHint = '';
  try { swipeHint = !state.selecting && 'ontouchstart' in window && !localStorage.getItem('buyercrm-swiped') ? `<p class="hint small center">Смахните заказ вправо — следующий статус, влево — написать в WhatsApp</p>` : ''; } catch (e) { /* нет — не страшно */ }
  return strip + swipeHint + body +
    (rest > 0 ? `<button class="btn" data-act="more">Показать ещё ${Math.min(rest, PAGE)} из ${rest}</button>` : '') +
    archiveHint;
}

// Строка заказа в списке: две короткие строки вместо большой карточки
function orderRow(o) {
  const sel = state.selecting;
  const checked = state.selected.includes(o.no);
  const debt = o.debt > 0 && !isCancelled(o);
  const i = statusIdx(o.status);
  const since = daysSince(o.statusAt || o.date);
  const slow = !isClosed(o) && i !== S.ARRIVED && since >= 7;
  return `
    <div class="lrow orow ${checked ? 'checked' : ''}" style="${statusStyle(i)}" data-act="${sel ? 'toggleSel' : 'openOrder'}" data-no="${o.no}" ${sel ? '' : 'data-swipe="1"'}>
      ${sel ? `<span class="check">${checked ? '✓' : ''}</span>` : `<span class="ava">${esc(initials(o.client))}</span>`}
      <div class="grow">
        <div class="l1"><span class="name ellipsis">${esc(o.client)}</span><span class="money">${money(o.total)}</span></div>
        <div class="l2"><span class="ellipsis">№${o.no} · <span class="st">${esc(o.status)}</span>${slow ? ` · <span class="slow">${daysWord(since)}</span>` : ''}</span>
          ${debt ? `<span class="debt money">долг ${moneyShort(o.debt)}</span>` : `<span class="nowrap">${o.count} шт</span>`}</div>
        ${isCancelled(o) ? '' : `<div class="prog">${FLOW.map(k => `<i class="${k <= i ? 'on' : ''}"></i>`).join('')}</div>`}
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

// Сводка по клиентам: из всех заказов (с архивом, если вкладка «Бизнес» уже загрузила его)
function clientStats() {
  const map = new Map();
  bizRows().forEach(r => {
    const k = clientKey(r);
    if (!map.has(k)) map.set(k, { key: k, name: r.client, phone: r.phone, count: 0, total: 0, profit: 0, debt: 0, active: 0, first: Infinity, last: 0, lastNo: 0, dates: [] });
    const c = map.get(k);
    const t = new Date(r.date).getTime();
    c.count++;
    c.total += Number(r.total) || 0;
    c.profit += Number(r.profit) || 0;
    c.debt += Math.max(0, (Number(r.total) || 0) - (Number(r.paid) || 0));
    if (statusIdx(r.status) !== S.DONE) c.active++;
    c.first = Math.min(c.first, t);
    c.last = Math.max(c.last, t);
    c.dates.push(t);
    if (r.no > c.lastNo) { c.lastNo = r.no; c.name = r.client; c.phone = r.phone; }
  });
  const list = [...map.values()];
  // ⭐ — самые ценные постоянные клиенты (верхние 15% по сумме покупок)
  const regulars = list.filter(c => c.count >= 3).sort((a, b) => b.total - a.total);
  regulars.slice(0, Math.max(1, Math.ceil(regulars.length * 0.15))).forEach(c => { c.vip = true; });
  list.forEach(c => {
    c.days = daysSince(c.last);
    const n = noteOf(c.key);
    c.bday = n.birthday ? birthdayIn(n.birthday) : null;
    c.isNew = daysSince(c.first) <= 30 && c.count <= 2;
  });
  return list;
}

// Что клиент любит: магазины и размеры из его заказов
function clientLikes(key) {
  const shops = {};
  const sizes = {};
  state.orders.filter(o => clientKey(o) === key && !isCancelled(o)).forEach(o => o.items.forEach(x => {
    if (isUrl(x.link)) { const s = site(x.link); shops[s] = (shops[s] || 0) + 1; }
    const z = String(x.size || '').split(/[·,;]/)[0].trim();
    if (z && z.length <= 12) sizes[z] = (sizes[z] || 0) + 1;
  }));
  const top = m => Object.keys(m).sort((a, b) => m[b] - m[a]).slice(0, 3);
  return { shops: top(shops), sizes: top(sizes) };
}

// Как часто заказывает: «раз в 3 нед»
function orderRhythm(dates) {
  const days = [...new Set(dates.map(t => Math.floor(t / 86400000)))].sort((a, b) => a - b);
  if (days.length < 2) return null;
  const gap = Math.max(1, Math.round((days[days.length - 1] - days[0]) / (days.length - 1)));
  const text = gap < 10 ? `раз в ${daysWord(gap)}` : gap < 50 ? `раз в ${Math.round(gap / 7)} нед` : `раз в ${Math.round(gap / 30)} мес`;
  const next = (days[days.length - 1] + gap) * 86400000;
  return { gap, text, next };
}

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
  const st = clientStats().find(x => x.key === key) || { count: orders.length, total: c.total, profit: 0, debt: c.debt, first: Date.now(), dates: [] };
  const chat = waLink(c.phone, '');
  const tel = c.phone ? `tel:${c.phone.replace(/[^\d+]/g, '')}` : '';
  const insta = (orders.find(o => o.instagram) || {}).instagram || '';
  const active = orders.filter(o => !isClosed(o));
  const closed = orders.filter(o => isClosed(o));
  const arrived = arrivedOf(key).length;
  const rhythm = orderRhythm(st.dates);
  const likes = clientLikes(key);
  const nextText = rhythm ? (rhythm.next < Date.now() ? 'уже пора написать' : `следующий ~ ${new Date(rhythm.next).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`) : '';

  return `
    <div class="card">
      <div class="row">
        <span class="ava big">${esc(initials(c.name))}</span>
        <div class="grow">
          <b class="ellipsis" style="display:block;font-size:18px">${esc(c.name)}${st.vip ? ` <span class="star">${icon('star')}</span>` : ''}</b>
          <div class="hint small">${esc(c.phone || (insta ? '' : 'без телефона'))}${insta ? `${c.phone ? ' · ' : ''}@${esc(insta)}` : ''}${isFinite(st.first) ? ` · клиент с ${fmtDate(new Date(st.first).toISOString(), true)}` : ''}</div>
        </div>
      </div>
      <div class="act-line">
        <button class="btn ${arrived ? '' : 'primary'}" data-act="newForClient" data-name="${esc(c.name)}" data-phone="${esc(c.phone)}">${icon('plus')}Заказ</button>
        ${chat ? `<button class="rbtn wa-ic" data-act="open" data-url="${esc(chat)}" aria-label="WhatsApp">${icon('chat')}</button>` : ''}
        ${insta ? `<button class="rbtn ig-ic" data-act="open" data-url="https://ig.me/m/${esc(insta)}" aria-label="Instagram">${icon('insta')}</button>` : ''}
        ${tel ? `<a class="rbtn" href="${esc(tel)}" aria-label="Позвонить">${icon('phone')}</a>` : ''}
        <button class="rbtn" data-act="reminderSheet" data-key="${esc(key)}" data-name="${esc(c.name)}" aria-label="Напомнить мне">${icon('bell')}</button>
      </div>
    </div>
    ${arrived ? `<button class="btn primary" data-act="openHandover" data-key="${esc(key)}">${icon('gift')}Выдать прибывшее (${arrived})</button>` : ''}

    <div class="kpi4">
      <div class="card"><span class="hint small">Купил(а) на</span><b class="money">${moneyShort(st.total)}</b><span class="hint small">${ordersWord(st.count)}</span></div>
      <div class="card"><span class="hint small">Принес(ла) прибыли</span><b class="money ok">${moneyShort(st.profit)}</b><span class="hint small">ср. чек ${moneyShort(st.count ? st.total / st.count : 0)}</span></div>
      <div class="card"><span class="hint small">Заказывает</span><b>${rhythm ? esc(rhythm.text) : 'пока 1 раз'}</b><span class="hint small">${esc(nextText) || '&nbsp;'}</span></div>
      <div class="card"><span class="hint small">Долг</span>${st.debt > 0 ? `<b class="debt money">${moneyShort(st.debt)}</b>` : '<b class="ok">нет</b>'}<span class="hint small">${st.debt > 0 ? 'ждём оплату' : 'всё оплачено'}</span></div>
    </div>

    ${likes.shops.length || likes.sizes.length ? `
      <div class="card">
        <div class="hint small" style="margin-bottom:6px">Что любит</div>
        <div class="tags">${likes.shops.map(x => `<span class="tag">${esc(x)}</span>`).join('')}${likes.sizes.map(x => `<span class="tag soft">${esc(x)}</span>`).join('')}</div>
      </div>` : ''}
    ${clientNoteHtml(key, c)}
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

// Поля, которых не было в старых черновиках
const DRAFT_EXTRAS = { delivery: '', discount: '', payMethod: '', due: '', comment: '', ratesOpen: false, addTo: null, dupHidden: false,
  instagram: '', quickOpen: true, quickText: '', quickInfo: '' };
const PAY_METHODS = ['Kaspi', 'Наличные', 'Перевод'];

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
    ...DRAFT_EXTRAS,
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
    return Object.assign({}, DRAFT_EXTRAS, d);
  } catch (e) { return null; }
}

// Считает цены по форме. Та же формула, что в боте и в таблице.
function calcDraft() {
  const d = state.draft;
  if (!d) return { items: [], total: 0, profit: 0, paid: 0, itemsTotal: 0, delivery: 0, discount: 0 };
  const markup = parseNum(d.markup) || 0;
  const rates = { '$': parseNum(d.rateUsd) || 0, '€': parseNum(d.rateEur) || 0, '₸': 1 };
  const items = d.items.map(it => {
    const qty = Math.max(1, Math.round(parseNum(it.qty)) || 1);
    const amount = parseNum(it.amount) || 0;
    const rate = rates[it.currency] || 0;
    const cost = qty * amount * rate;
    return { qty, amount, rate, cost, price: calcPrice(cost, markup, state.settings.round) };
  });
  const itemsTotal = items.reduce((a, x) => a + x.price, 0);
  // Доставка и скидка — только для нового заказа (не при добавлении в существующий)
  const delivery = d.addTo ? 0 : Math.max(0, Math.round(parseNum(d.delivery) || 0));
  const discount = d.addTo ? 0 : Math.max(0, Math.round(parseNum(d.discount) || 0));
  const total = Math.max(0, itemsTotal + delivery - discount);
  const profit = items.reduce((a, x) => a + (x.price ? x.price - x.cost : 0), 0) - discount;
  const paid = d.paidMode === 'all' ? total
    : d.paidMode === 'half' ? Math.round(total / 2 / 100) * 100
    : d.paidMode === 'custom' ? Math.max(0, parseNum(d.paidCustom) || 0) : 0;
  return { items, total, profit, paid, markup, rates, itemsTotal, delivery, discount };
}

function newOrderTab() {
  const d = state.draft;
  const c = calcDraft();
  const hasEur = d.items.some(x => x.currency === '€');
  const known = d.picked ? findClient(d.client, d.phone) : null;
  const key = d.picked ? clientKey({ client: d.client, phone: d.phone }) : null;
  const mine = key ? state.orders.filter(o => clientKey(o) === key).sort((a, b) => b.no - a.no) : [];
  const open = mine.find(o => [S.WAIT, S.PAID].includes(statusIdx(o.status)));
  const prev = mine.find(o => !isCancelled(o));
  const sizes = key ? clientLikes(key).sizes : [];
  const blank = d.items.every(it => !it.link.trim() && !it.amount.trim() && !it.size.trim());
  const failed = state.failedDraft;
  const n = d.items.filter(it => it.link.trim() || it.amount.trim()).length;

  return `
    ${failed ? `<div class="card failed-card">
      <b>${failed.failed ? 'Не сохранился заказ' : 'Отложен черновик заказа'} для «${esc(failed.client || failed.phone || 'без имени')}»</b>
      <div class="btn-row tight">
        <button class="btn small primary" data-act="restoreFailed">Восстановить</button>
        <button class="btn small" data-act="dropFailed">Удалить</button>
      </div></div>` : ''}

    <div class="entry2">
      <button class="card entry ${d.quickOpen ? 'on' : ''}" data-act="quickToggle">${icon('bolt')}<b>Быстрая строка</b><span class="hint small">мария nike.com 10us 120$</span></button>
      <button class="card entry ${d.pasteOpen ? 'on' : ''}" data-act="pasteToggle">${icon('paste')}<b>Вставить сообщение</b><span class="hint small">из WhatsApp</span></button>
    </div>
    ${d.quickOpen ? `
      <div class="card">
        <textarea class="input quick-in" data-f="quickText" rows="3" placeholder="мария nike.com 10us black 120$&#10;zara.com S бежевый 59$ x2">${esc(d.quickText)}</textarea>
        <button class="btn primary" data-act="quickApply" style="margin-top:8px">Заполнить</button>
        ${d.quickInfo ? `<div class="paste-info">${d.quickInfo}</div>` : `<div class="hint small" style="margin-top:8px">Клиент — имя, телефон или @ник. Цена — со значком: 120$, 95€, 45000тг. Каждый товар — с новой строки, количество — x2. Можно дописать «опт» или «оплачено».</div>`}
      </div>` : ''}
    ${d.pasteOpen ? `
      <div class="card">
        <textarea class="input" data-f="pasteText" placeholder="Вставьте сюда текст из WhatsApp: телефон, ссылки, цены, размер…">${esc(d.pasteText)}</textarea>
        <button class="btn primary" data-act="parsePaste" style="margin-top:8px">Заполнить форму</button>
        ${d.pasteInfo ? `<div class="paste-info">${d.pasteInfo}</div>` : ''}
      </div>` : ''}

    <div class="section-title">Клиент</div>
    <div class="card">
      ${clientFieldHtml(d, known)}
      ${d.addTo ? `<div class="infobox accent">${icon('plus')}<span class="grow">Товары добавятся в заказ №${d.addTo}</span><button class="link-btn" data-act="addToCancel">Отменить</button></div>`
        : open && !d.dupHidden ? `<div class="infobox">${icon('note')}<span class="grow">У клиента есть заказ №${open.no} «${esc(open.status)}» — добавить товары в него?</span></div>
          <div class="btn-row tight"><button class="btn small" data-act="addToOrder" data-no="${open.no}">Добавить в №${open.no}</button><button class="btn small" data-act="dupHide">Новый заказ</button></div>` : ''}
      <div class="row" style="margin-top:12px;gap:8px">
        <div class="seg grow">
          <button class="${d.opt ? '' : 'on'}" data-act="opt" data-v="0">Розница</button>
          <button class="${d.opt ? 'on' : ''}" data-act="opt" data-v="1">Опт</button>
        </div>
        ${prev && blank && !d.addTo ? `<button class="chip" data-act="repeatLast" data-no="${prev.no}">${icon('repeat')}Как в прошлый раз</button>` : ''}
      </div>
    </div>

    <div class="section-title">Товары${d.items.length > 1 ? ' · ' + d.items.length : ''}</div>
    ${d.items.map((it, i) => itemFormHtml(it, i, c.items[i], d.items.length, sizes)).join('')}
    <button class="btn ghost" data-act="addItem">${icon('plus')}Добавить товар</button>

    ${d.ratesOpen ? `
      <div class="section-title row between"><span>Наценка и курс</span><button class="link-btn" data-act="ratesToggle">Свернуть</button></div>
      <div class="card">
        <div class="fields-row">
          <div class="field"><label>Наценка, %</label>
            <input class="input" data-f="markup" inputmode="decimal" value="${esc(d.markup)}"></div>
          <div class="field"><label>Курс $, ₸</label>
            <input class="input" data-f="rateUsd" inputmode="decimal" value="${esc(d.rateUsd)}"></div>
          ${hasEur ? `<div class="field"><label>Курс €, ₸</label>
            <input class="input" data-f="rateEur" inputmode="decimal" value="${esc(d.rateEur)}"></div>` : ''}
        </div>
      </div>` : `
      <button class="card fold" data-act="ratesToggle">
        <span class="grow"><span class="hint small">Наценка и курс</span><span class="fold-v">${esc(d.markup || 0)}% · $ ${esc(d.rateUsd || '—')} ₸${hasEur ? ` · € ${esc(d.rateEur || '—')} ₸` : ''}</span></span>
        <span class="link-btn">Изменить</span>
      </button>`}

    ${d.addTo ? '' : `
      <div class="section-title">Добавить к цене</div>
      <div class="card">
        <div class="xrow">${icon('truck')}<span class="grow">Доставка клиенту</span>
          <input class="input xin" data-f="delivery" inputmode="numeric" placeholder="0 ₸" value="${esc(d.delivery)}"></div>
        <div class="xrow">${icon('percent')}<span class="grow">Скидка</span>
          <button class="chip sm" data-act="discountPct" data-v="5">5%</button><button class="chip sm" data-act="discountPct" data-v="10">10%</button>
          <input class="input xin" data-f="discount" inputmode="numeric" placeholder="0 ₸" value="${esc(d.discount)}"></div>
      </div>`}

    <div class="section-title">Сколько клиент уже оплатил?</div>
    <div class="card">
      <div class="seg" id="paidSeg">
        <button class="${d.paidMode === 'all' ? 'on' : ''}" data-act="paid" data-v="all">Всё</button>
        <button class="${d.paidMode === 'half' ? 'on' : ''}" data-act="paid" data-v="half">50%</button>
        <button class="${d.paidMode === 'none' ? 'on' : ''}" data-act="paid" data-v="none">Ничего</button>
        <button class="${d.paidMode === 'custom' ? 'on' : ''}" data-act="paid" data-v="custom">Сумма</button>
      </div>
      ${d.paidMode === 'custom' ? `<div class="field" style="margin-top:10px">
        <input class="input" data-f="paidCustom" inputmode="decimal" placeholder="Сумма, ₸" value="${esc(d.paidCustom)}"></div>` : ''}
      ${d.paidMode && d.paidMode !== 'none' ? `<div class="chips plain" style="margin-top:10px">${PAY_METHODS.map(m =>
        `<button class="chip sm ${d.payMethod === m ? 'on' : ''}" data-act="payMethod" data-v="${m}">${m}</button>`).join('')}</div>` : ''}
    </div>

    ${d.addTo ? '' : `
      <div class="section-title">Ещё</div>
      <div class="card">
        <div class="xrow">${icon('calendar')}<span class="grow">Нужно к дате</span>
          <input class="input xin wide" type="date" data-f="due" value="${esc(d.due)}"></div>
        <div class="xrow">${icon('note')}<input class="input grow" data-f="comment" placeholder="Комментарий: подарок, без чека…" value="${esc(d.comment)}" autocomplete="off"></div>
      </div>`}

    <div class="sum-bar">
      <div class="row between">
        <div><span class="hint small">Клиенту${n ? ' · ' + n + ' ' + (n === 1 ? 'товар' : n < 5 ? 'товара' : 'товаров') : ''}</span><b class="sum-v money" id="dTotal">${money(c.total)}</b></div>
        <div class="r"><span class="hint small">Ваша прибыль</span><b class="ok money" id="dProfit">${money(c.profit)}</b></div>
      </div>
      <div class="hint small" id="dLeft">${leftText(c)}</div>
    </div>

    <button class="link-btn" data-act="clearDraft" style="margin-top:6px;color:var(--hint)">Очистить форму</button>`;
}

function itemFormHtml(it, i, calc, count, sizes) {
  const shop = isUrl(it.link) ? site(it.link) : '';
  return `
    <div class="card item-card">
      <div class="item-head">
        <span class="row" style="gap:8px"><span class="num">${i + 1}</span>${shop ? `<span class="tag">${esc(shop)}</span>` : 'Товар'}</span>
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
      ${sizes && sizes.length ? `<div class="size-hint"><span class="hint small">обычно:</span>${sizes.map(z =>
        `<button class="chip sm ${it.size === z ? 'on' : ''}" data-act="sizePick" data-i="${i}" data-v="${esc(z)}">${esc(z)}</button>`).join('')}</div>` : ''}
      <div class="fields-row">
        <div class="field" style="flex:1.4">
          <input class="input" data-f="amount" data-i="${i}" inputmode="decimal" value="${esc(it.amount)}"
            placeholder="Цена${Number(it.qty) > 1 ? ' за 1 шт' : ''} на сайте">
        </div>
        <div class="field">
          <div class="seg">
            ${['$', '€', '₸'].map(cur => `<button class="${it.currency === cur ? 'on' : ''}" data-act="cur" data-i="${i}" data-v="${cur}">${cur}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="item-price row between" id="ip${i}">${itemPriceHtml(it, calc)}</div>
    </div>`;
}

function itemPriceHtml(it, calc) {
  if (!calc || !calc.price) return `<span class="hint">Цена клиенту появится, когда введёте цену</span>`;
  const how = it.currency === '₸' ? `${fmtNum(calc.amount)} ₸ × ${calc.qty} + наценка` : `${fmtNum(calc.amount)} ${it.currency} × ${calc.qty} × ${fmtNum(calc.rate)} ₸ + наценка`;
  return `<span class="hint">${how}</span><b class="money">${money(calc.price)}</b>`;
}

function leftText(c) {
  const extra = [];
  if (c.delivery) extra.push(`доставка ${money(c.delivery)}`);
  if (c.discount) extra.push(`скидка −${money(c.discount)}`);
  const ex = extra.length ? `В сумме: ${extra.join(', ')}. ` : '';
  if (!state.draft.paidMode) return ex + 'Отметьте оплату — так долги не потеряются';
  const left = c.total - c.paid;
  return ex + (left > 0 ? `Останется долг: <span class="debt">${money(left)}</span>` : 'Долга не будет ✅');
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
  // Подгружаем старые заказы клиента: из них берём «обычные» размеры и «Как в прошлый раз»
  const key = clientKey({ client: name || '', phone: phone || '' });
  if (clientLoadKey !== key) {
    clientLoadKey = key;
    api('clientOrders', { key }).then(res => {
      mergeOrders(res.orders);
      if (state.tab === 'new' && !state.stack.length) softRender();
    }).catch(() => { clientLoadKey = null; });
  }
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
          <span class="hint small">${esc(d.phone || (d.instagram ? '' : 'без телефона'))}${d.instagram ? `${d.phone ? ' · ' : ''}@${esc(d.instagram)}` : ''}</span>
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
  const noRate = ['$', '€'].find(cur => filled.some(({ it }) => it.currency === cur) && !(c.rates[cur] > 0));
  if (noRate) {
    if (!d.ratesOpen) { d.ratesOpen = true; render(); }
    return bad(noRate === '$' ? '[data-f="rateUsd"]' : '[data-f="rateEur"]', `Укажите курс ${noRate}`);
  }
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
      delivery: c.delivery, discount: c.discount, payMethod: d.paidMode && d.paidMode !== 'none' ? d.payMethod : '',
      due: d.due || '', comment: (d.comment || '').trim(), instagram: d.instagram || '',
    },
  };
  if (d.addTo) return addToExisting(d, payload.order);

  // Чек показываем сразу (суммы посчитаны на телефоне по той же формуле), номер подставим, когда ответит таблица
  const preview = {
    no: null, client: payload.order.client, phone: payload.order.phone,
    items: filled.map(({ it, i }) => ({ link: it.link.trim(), size: it.size.trim(), qty: c.items[i].qty, price: c.items[i].price })),
    total: c.total, paid: c.paid, debt: c.total - c.paid, profit: c.profit, delivery: c.delivery, discount: c.discount,
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

// Дописать товары в заказ клиента, который ещё не выкупали
function addToExisting(d, order) {
  const no = d.addTo;
  const savedDraft = JSON.parse(JSON.stringify(d));
  haptic('success');
  state.draft = newDraft();
  saveDraft();
  state.stack = [];
  state.tab = 'orders';
  openScreen({ type: 'order', no });
  toast(`Добавляю товары в заказ №${no}…`);
  syncPending++;
  updateSyncBadge();
  syncQueue = syncQueue.then(async () => {
    try {
      const res = await api('addItems', { no, items: order.items, markup: order.markup, rates: order.rates, paid: order.paid });
      mergeOrders(res.orders);
      toast(`Товары добавлены в заказ №${no} ✅`);
    } catch (err) {
      console.error(err);
      onOrderFailed(savedDraft, null, err);
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

// Быстрая строка → форма. Сам разбор — в quick.js (такой же у бота)
function applyQuick() {
  const d = state.draft;
  const p = parseQuick(d.quickText || '');
  if (!p.items.length && !p.name && !p.phone && !p.instagram) {
    d.quickInfo = '🤔 Ничего не понятно. Пример: <b>мария nike.com 10us black 120$</b>';
    render();
    haptic('warning');
    return;
  }
  const found = [];
  // Клиент: по телефону, по @нику, по имени
  let known = p.phone ? findClient('', p.phone) : null;
  if (!known && p.instagram) {
    const o = state.orders.slice().sort((a, b) => b.no - a.no).find(x => x.instagram === p.instagram);
    if (o) known = { name: o.client, phone: o.phone, count: state.orders.filter(x => clientKey(x) === clientKey(o)).length };
  }
  let several = 0;
  if (!known && p.name && !p.phone) {
    const low = p.name.toLowerCase();
    const list = clientList().filter(c => c.name.toLowerCase().startsWith(low));
    if (list.length === 1) known = list[0];
    several = list.length > 1 ? list.length : 0;
  }
  if (known) {
    pickDraftClient(known.name, known.phone);
    found.push(`клиент из базы — ${esc(known.name)}`);
  } else if (several) {
    d.picked = false; d.client = p.name; d.phone = ''; d.who = p.name;
    found.push(`клиентов «${esc(p.name)}» несколько — выберите ниже`);
  } else if (p.name || p.phone || p.instagram) {
    pickDraftClient(p.name || (p.instagram ? '@' + p.instagram : ''), p.phone ? formatPhone(p.phone) : '');
    found.push(`новый клиент ${esc(p.name || p.phone || '@' + p.instagram)}`);
  }
  if (p.instagram) d.instagram = p.instagram;

  if (p.items.length) {
    const blank = d.items.every(it => !it.link.trim() && !it.amount.trim() && !it.size.trim());
    if (blank) d.items = [];
    p.items.forEach(x => d.items.push({
      link: x.link, size: x.size, qty: String(x.qty), amount: x.amount ? String(x.amount) : '', currency: x.currency,
    }));
    found.push(`товаров: ${p.items.length}`);
  }
  if (p.opt && !d.opt) {
    d.opt = true;
    if (!d.markupTouched) d.markup = String(state.settings.opt);
  }
  if (p.paid) d.paidMode = 'all';
  const missing = p.problems.filter(x => x.startsWith('нет цены'));
  d.quickInfo = `✅ ${found.join(', ')}.` + (missing.length ? ` <b class="debt">${esc(missing.join(', '))} — допишите ниже.</b>` : ' Проверьте и сохраните.');
  d.quickText = '';
  saveDraft();
  render();
  haptic(missing.length ? 'warning' : 'success');
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
      <div class="hint small" style="margin-top:8px">Ваша прибыль: ${money(o.profit)}${o.delivery > 0 ? ` · доставка ${money(o.delivery)}` : ''}${o.discount > 0 ? ` · скидка ${money(o.discount)}` : ''}${o.payMethod ? ` · ${esc(o.payMethod)}` : ''}</div>
      ${o.due && !isClosed(o) ? `<div class="small" style="margin-top:6px">${icon('calendar')} Нужно к ${esc(new Date(o.due).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }))}</div>` : ''}
      ${o.comment ? `<div class="small" style="margin-top:6px">${icon('note')} ${esc(o.comment)}</div>` : ''}
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
    // «Нужно к дате»: за 3 дня до срока, пока заказ не прибыл
    if (o.due && !isClosed(o) && i < S.ARRIVED) {
      const left = Math.ceil((new Date(o.due) - now) / 86400000);
      if (left <= 3) {
        const when = new Date(o.due).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        out.push({ o, kind: i <= S.PAID ? 'buy' : 'delivery', prio: 0, days: -left,
          text: left < 0 ? `срок ${when} прошёл` : `нужно к ${when}${left === 0 ? ' — сегодня' : `, осталось ${daysWord(left)}`}`, btn: 'Открыть', act: 'openOrder' });
        return;
      }
    }
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
  const kinds = { 1: 'buy', 2: 'delivery', 3: 'debt', 4: 'debt', 5: 'delivery' };
  out.forEach(x => { if (!x.kind) x.kind = kinds[x.prio]; });
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

function greetingTitle() {
  const h = new Date().getHours();
  const g = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const u = IN_TG && tg.initDataUnsafe && tg.initDataUnsafe.user;
  return u && u.first_name ? `${g}, ${u.first_name}` : g;
}

// Цифры текущего месяца для главного экрана
function monthStats() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const prevTo = Math.min(from, prevFrom + (now.getTime() - from)); // те же дни прошлого месяца
  const rows = bizRows();
  const cur = rows.filter(r => new Date(r.date).getTime() >= from);
  const prev = rows.filter(r => { const t = new Date(r.date).getTime(); return t >= prevFrom && t < prevTo; });
  const revenue = sumBy(cur, 'total');
  const profit = sumBy(cur, 'profit');
  const expenses = (state.expenses || []).filter(e => new Date(e.date).getTime() >= from).reduce((a, e) => a + e.amount, 0);
  const tax = Math.round(revenue * (Number(state.settings.taxRate) || 0) / 100);
  const dayNo = now.getDate();
  const days = Array.from({ length: dayNo }, () => 0);
  cur.forEach(r => { const k = new Date(r.date).getDate() - 1; if (k >= 0 && k < dayNo) days[k] += Number(r.profit) || 0; });
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return {
    revenue, profit, prevProfit: sumBy(prev, 'profit'), expenses, take: Math.max(0, profit - expenses - tax),
    days, daysLeft: daysInMonth - dayNo, monthName: now.toLocaleString('ru-RU', { month: 'long' }),
  };
}

// Маленький график прибыли по дням месяца
function sparkHtml(days) {
  const max = Math.max(1, ...days);
  const w = 6, gap = 3, h = 36;
  return `<svg class="spark" viewBox="0 0 ${days.length * (w + gap)} ${h}" preserveAspectRatio="none" aria-hidden="true">${days.map((v, i) => {
    const bh = Math.max(2, Math.round(v / max * h));
    return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="2"${i === days.length - 1 ? ' class="last"' : ''}/>`;
  }).join('')}</svg>`;
}

function heroHtml() {
  const m = monthStats();
  const goal = Number(state.settings.goal) || 0;
  const pct = goal ? Math.min(100, Math.round(m.revenue / goal * 100)) : 0;
  const ready = !!state.analytics; // расходы и прошлый месяц приходят вместе с аналитикой
  const delta = ready && m.prevProfit > 0 ? Math.round((m.profit - m.prevProfit) / m.prevProfit * 100) : null;
  return `
    <div class="card hero" data-act="tab" data-tab="biz">
      <div class="row between"><span class="hint small">Прибыль за ${esc(m.monthName)}</span>
        ${delta !== null ? `<span class="small ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}% к прошлому месяцу</span>` : ''}</div>
      <div class="hero-main"><b class="hero-v money">${money(m.profit)}</b>${sparkHtml(m.days)}</div>
      ${goal ? `<div class="hero-bar"><span style="width:${pct}%"></span></div>
        <div class="hint small">Цель ${moneyShort(goal)} выручки · ${pct}% · ${m.daysLeft ? `осталось ${daysWord(m.daysLeft)}` : 'последний день'}</div>`
        : `<button class="link-btn" data-act="goalSheet" style="padding:2px 0">Поставить цель на месяц</button>`}
      <div class="hero-3">
        <div><span class="hint small">Выручка</span><b class="money">${moneyShort(m.revenue)}</b></div>
        <div><span class="hint small">Расходы</span><b class="money">${ready ? moneyShort(m.expenses) : '…'}</b></div>
        <div><span class="hint small">Можно взять</span><b class="money accent">${ready ? moneyShort(m.take) : '…'}</b></div>
      </div>
    </div>`;
}

function todayTab() {
  if (!state.analytics && !state.analyticsError) loadAnalytics();
  const dateText = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const u = IN_TG && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const ava = u && u.photo_url ? `<img src="${esc(u.photo_url)}" alt="">` : esc(((u && u.first_name) || state.settings.shopName || 'Я').replace(/[^\p{L}]/gu, '').charAt(0).toUpperCase() || 'Я');
  const tasks = homeTasks();
  const rem = homeReminders();
  return `
    <div class="h14-hd">
      <div class="grow"><small>${esc(dateText.charAt(0).toUpperCase() + dateText.slice(1))}</small><b>${esc(greetingTitle())}</b></div>
      <button class="h14-ib" data-act="goSearch" aria-label="Поиск">${icon('search')}</button>
      <button class="h14-me" data-act="openSettings" aria-label="Профиль и настройки">${ava}</button>
    </div>
    ${moneyCardsHtml()}
    <div class="h14-bar">
      <button data-act="openParcel">${icon('truck')}Посылка</button>
      <button data-act="tabDebts">${icon('cash')}Оплата</button>
      <button data-act="openHandoverList">${icon('gift')}Выдать</button>
      <button data-act="openCalc">${icon('calc')}Цена</button>
    </div>
    <div class="h14-sec"><b>Сделать сегодня</b><span>${tasks.length ? `${tasks.length} ${tasks.length === 1 ? 'дело' : tasks.length < 5 ? 'дела' : 'дел'}` : ''}</span></div>
    ${tasks.length ? tasks.map(taskCardHtml).join('')
      : `<div class="h14-task done"><span class="h14-i" style="background:#16A34A">${icon('check')}</span><span class="grow"><b>На сегодня всё</b><small>Новые дела появятся сами</small></span></div>`}
    ${rem.length ? `<div class="h14-sec"><b>Напоминания</b></div><div class="h14-rem">${rem.join('')}</div>` : ''}`;
}

// Три листаемые карточки: прибыль, долги, «на выкуп»
function moneyCardsHtml() {
  const m = monthStats();
  const ready = !!state.analytics;
  const delta = ready && m.prevProfit > 0 ? Math.round((m.profit - m.prevProfit) / m.prevProfit * 100) : null;
  const debts = debtOrders();
  const debtSum = debts.reduce((a, o) => a + o.debt, 0);
  const debtClients = groupByClient(debts).length;
  const oldDebts = debts.filter(o => daysSince(o.date) >= 7).length;
  const paid = state.orders.filter(o => statusIdx(o.status) === S.PAID);
  const onHand = paid.reduce((a, o) => a + (Number(o.paid) || 0), 0);
  return `
    <div class="h14-cards" id="hvCards">
      <div class="h14-c h14-profit" data-act="tab" data-tab="biz">
        <small>Прибыль · ${esc(m.monthName)}</small>
        <b class="money">${money(m.profit)}</b>
        <span>${delta !== null ? `<em class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}%</em> к прошлому месяцу · ` : ''}выручка ${moneyShort(m.revenue)}</span>
        ${revenueChartHtml()}
      </div>
      <div class="h14-c h14-debt" data-act="tabDebts">
        <small>Вам должны</small>
        <b class="money">${money(debtSum)}</b>
        <span>${debtClients ? `${debtClients} ${debtClients === 1 ? 'клиент' : debtClients < 5 ? 'клиента' : 'клиентов'}${oldDebts ? ` · ${oldDebts} дольше недели` : ''}` : 'никто не должен'}</span>
        <i class="h14-act">Открыть ${icon('chevron')}</i>
      </div>
      <div class="h14-c h14-buy" data-act="openBuy">
        <small>На выкуп</small>
        <b class="money">${money(onHand)}</b>
        <span>Клиенты оплатили, ещё не выкуплено · ${ordersWord(paid.length)}</span>
        <i class="h14-act">Открыть список ${icon('chevron')}</i>
      </div>
    </div>
    <div class="h14-dots" id="hvDots"><i class="on"></i><i></i><i></i></div>`;
}

// Выручка по дням текущего месяца: столбики, среднее, лучший день
function revenueChartHtml() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const n = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const today = now.getDate();
  const days = Array.from({ length: n }, () => 0);
  bizRows().forEach(r => { const t = new Date(r.date); if (t.getTime() >= from && t.getMonth() === now.getMonth()) days[t.getDate() - 1] += Number(r.total) || 0; });
  const past = days.slice(0, today);
  const max = Math.max(1, ...past);
  const best = past.indexOf(Math.max(...past));
  const avg = past.reduce((a, v) => a + v, 0) / Math.max(1, today);
  const W = 300, H = 62, gap = 2.2, bw = (W - gap * (n - 1)) / n, top = max * 1.08;
  const y = v => H - v / top * H;
  const step = top > 400000 ? 200000 : top > 200000 ? 100000 : 50000;
  let out = '';
  for (let v = step; v < top; v += step) out += `<line x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="rgba(255,255,255,.08)"/><text x="${W + 4}" y="${(y(v) + 3).toFixed(1)}" class="h14-ax">${v / 1000}к</text>`;
  days.forEach((v, i) => {
    const x = i * (bw + gap);
    if (i >= today) { out += `<rect x="${x.toFixed(1)}" y="${H - 2}" width="${bw.toFixed(1)}" height="2" rx="1" fill="rgba(255,255,255,.12)"/>`; return; }
    const yy = Math.min(H - 2, y(v)), r = Math.min(2.5, bw / 2);
    const fill = i === best && v > 0 ? '#60A5FA' : i === today - 1 ? 'rgba(255,255,255,.38)' : 'rgba(255,255,255,.2)';
    out += `<path d="M${x.toFixed(1)},${H} V${(yy + r).toFixed(1)} Q${x.toFixed(1)},${yy.toFixed(1)} ${(x + r).toFixed(1)},${yy.toFixed(1)} H${(x + bw - r).toFixed(1)} Q${(x + bw).toFixed(1)},${yy.toFixed(1)} ${(x + bw).toFixed(1)},${(yy + r).toFixed(1)} V${H} Z" fill="${fill}"/>`;
  });
  if (avg > 0) out += `<line x1="0" x2="${W}" y1="${y(avg).toFixed(1)}" y2="${y(avg).toFixed(1)}" stroke="#93C5FD" stroke-dasharray="3 3"/>`;
  [1, 8, 15, 22, n].forEach(d => { out += `<text x="${((d - 1) * (bw + gap) + bw / 2).toFixed(1)}" y="${H + 13}" text-anchor="middle" class="h14-ax">${d}</text>`; });
  const bx = best * (bw + gap) + bw / 2;
  const tip = past[best] > 0 ? `<div class="h14-tip" style="left:${(bx / (W + 26) * 100).toFixed(1)}%"><b>${moneyShort(past[best])}</b>${esc(new Date(now.getFullYear(), now.getMonth(), best + 1).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }))}</div>` : '';
  return `<div class="h14-chart">${tip}<svg viewBox="0 0 ${W + 26} ${H + 16}" role="img" aria-label="Выручка по дням">${out}</svg></div>`;
}

// Дела на сегодня — появляются, только когда они есть
function homeTasks() {
  const by = i => state.orders.filter(o => statusIdx(o.status) === i);
  const list = [];
  attentionItems().filter(x => x.prio === 0).forEach(x => list.push({
    ic: 'calendar', color: '#EF4444', title: `№${x.o.no} · ${x.o.client}`, sub: x.text.charAt(0).toUpperCase() + x.text.slice(1),
    act: 'openOrder', data: `data-no="${x.o.no}"`, right: icon('chevron'),
  }));
  const paid = by(S.PAID);
  const toBuy = buyItems().filter(x => !x.item.bought);
  if (paid.length) list.push({ ic: 'cart', color: '#F97316', title: 'Выкупить', sub: `Оплачены · ${moneyShort(toBuy.reduce((a, x) => a + (x.item.cost || 0), 0))}`, act: 'openBuy', num: paid.length });
  const wait = by(S.WAIT);
  const debts = debtOrders().filter(o => statusIdx(o.status) !== S.WAIT);
  if (wait.length || debts.length) list.push({ ic: 'cash', color: '#F59E0B', title: 'Ждут оплаты', sub: [wait.length ? `${wait.length} новых` : '', debts.length ? `${debts.length} с долгом` : ''].filter(Boolean).join(' · '), act: 'tabDebts', num: wait.length + debts.length });
  const toSend = state.orders.filter(o => [S.BOUGHT, S.STOCK].includes(statusIdx(o.status)));
  if (toSend.length) list.push({ ic: 'truck', color: '#0EA5E9', title: 'Отправить посылку', sub: 'Выкуплены и ждут отправки', act: 'tile', data: 'data-v="going"', num: toSend.length });
  const arrived = by(S.ARRIVED);
  if (arrived.length) list.push({ ic: 'gift', color: '#16A34A', title: 'Выдать', sub: `Ждут ${groupByClient(arrived).length} клиентов`, act: 'openHandoverList', num: arrived.length });
  return list;
}

function taskCardHtml(t) {
  return `<button class="h14-task" data-act="${t.act}" ${t.data || ''}>
    <span class="h14-i" style="background:${t.color}">${icon(t.ic)}</span>
    <span class="grow"><b>${esc(t.title)}</b><small>${esc(t.sub)}</small></span>
    ${t.num ? `<span class="h14-n">${t.num}</span>` : t.right || ''}
  </button>`;
}

// Свои напоминания на сегодня и дни рождения сегодня — короткими строками
function homeReminders() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const rows = [];
  (state.reminders || []).filter(r => new Date(r.when) < end).sort((a, b) => new Date(a.when) - new Date(b.when)).forEach(r => {
    const t = new Date(r.when);
    const due = t <= now;
    rows.push(`<div class="h14-rr">
      <span class="h14-ri" style="background:#8B5CF6">${icon('bell')}</span>
      <span class="grow" ${r.no ? `data-act="openOrder" data-no="${r.no}"` : r.key ? `data-act="openClient" data-key="${esc(r.key)}"` : ''}>${esc(r.text)}</span>
      <span class="h14-rv ${due ? 'now' : ''}">${due ? 'пора' : t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
      <button class="h14-rx" data-act="reminderDone" data-id="${esc(r.id)}" aria-label="Готово">${icon('check')}</button>
    </div>`);
  });
  const clients = groupByClient(state.orders);
  Object.keys(state.notes || {}).forEach(key => {
    const n = state.notes[key];
    if (!n.birthday || birthdayIn(n.birthday) !== 0) return;
    const c = clients.find(x => x.key === key) || (state.clients || []).map(x => ({ key: clientKey({ client: x.name, phone: x.phone }), ...x })).find(x => x.key === key);
    if (!c) return;
    const url = waLink(c.phone, fillText(state.texts.birthday || '{client}, с днём рождения! 🎂', { client: c.name.split(' ')[0], no: '', debt: 0, track: '' }));
    rows.push(`<div class="h14-rr">
      <span class="h14-ri" style="background:#EC4899">${icon('cake')}</span>
      <span class="grow" data-act="openClient" data-key="${esc(key)}">ДР · ${esc(c.name)}</span>
      ${url ? `<button class="h14-rv link" data-act="open" data-url="${esc(url)}">Поздравить</button>` : '<span class="h14-rv">сегодня</span>'}
    </div>`);
  });
  return rows;
}

// «В планах»: мои напоминания и ближайшие дни рождения — одним списком
function plansHtml() {
  const now = new Date();
  const rows = [];
  (state.reminders || []).slice().sort((a, b) => new Date(a.when) - new Date(b.when)).slice(0, 5).forEach(r => {
    const t = new Date(r.when);
    const due = t <= now;
    const sameDay = t.toDateString() === now.toDateString();
    const when = sameDay || due ? t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    rows.push(`
      <div class="lrow ${due ? 'due' : ''}">
        <span class="when ${due ? 'now' : ''}">${due ? 'пора' : esc(when)}</span>
        <div class="grow" ${r.no ? `data-act="openOrder" data-no="${r.no}"` : r.key ? `data-act="openClient" data-key="${esc(r.key)}"` : ''}>
          <div class="l1"><span class="name ellipsis">${esc(r.text)}</span></div>
          ${due || !sameDay ? `<div class="l2">${t.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>` : ''}
        </div>
        <button class="rbtn sm" data-act="reminderDone" data-id="${esc(r.id)}" aria-label="${due ? 'Готово' : 'Удалить'}">${due ? icon('check') : '✕'}</button>
      </div>`);
  });
  const clients = groupByClient(state.orders);
  Object.keys(state.notes || {}).forEach(key => {
    const n = state.notes[key];
    if (!n.birthday) return;
    const days = birthdayIn(n.birthday);
    if (days > 7) return;
    const c = clients.find(x => x.key === key) || (state.clients || []).map(x => ({ key: clientKey({ client: x.name, phone: x.phone }), ...x })).find(x => x.key === key);
    if (!c) return;
    const url = days === 0 && waLink(c.phone, fillText(state.texts.birthday || '{client}, с днём рождения! 🎂', { client: c.name.split(' ')[0], no: '', debt: 0, track: '' }));
    rows.push(`
      <div class="lrow">
        <span class="when cake">${icon('cake')}</span>
        <div class="grow" data-act="openClient" data-key="${esc(key)}">
          <div class="l1"><span class="name ellipsis">День рождения: ${esc(c.name)}</span></div>
          <div class="l2">${days === 0 ? '<b class="ok">сегодня</b>' : days === 1 ? 'завтра' : `через ${daysWord(days)}`}</div>
        </div>
        ${url ? `<button class="rbtn sm wa-ic" data-act="open" data-url="${esc(url)}" aria-label="Поздравить">${icon('chat')}</button>` : ''}
      </div>`);
  });
  if (!rows.length) return '';
  return `<div class="section-title">В планах</div><div class="list">${rows.join('')}</div>`;
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
  if (['biz', 'today', 'clients'].includes(state.tab) && !state.stack.length) softRender();
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

const CLIENT_SEGS = [['all', 'Все'], ['debt', 'Должники'], ['regular', 'Постоянные'], ['lost', 'Давно не было'], ['new', 'Новые']];
const CLIENT_SORTS = { recent: 'Недавние', total: 'По сумме покупок', debt: 'По долгу' };

function clientSeg(c, seg) {
  if (seg === 'debt') return c.debt > 0;
  if (seg === 'regular') return c.count >= 3;
  if (seg === 'lost') return c.days > 60 && !c.active;
  if (seg === 'new') return c.isNew;
  return true;
}

function clientsTab() {
  if (!state.analytics && !state.analyticsError) loadAnalytics(); // с архивом цифры по клиентам точнее
  const all = clientStats();
  const chips = CLIENT_SEGS.map(([v, label]) => {
    const n = all.filter(c => clientSeg(c, v)).length;
    return n || state.cseg === v ? `<button class="chip ${state.cseg === v ? 'on' : ''}" data-act="cseg" data-v="${v}">${label}<span class="n">${n}</span></button>` : '';
  }).join('');
  return `
    <div class="search-wrap">${icon('search')}
      <input id="csearch" class="input search" type="search" placeholder="Имя или телефон" value="${esc(state.cquery)}" autocomplete="off">
    </div>
    <div class="chips">${chips}</div>
    <div class="toolbar"><button class="link-btn" data-act="csort">${icon('sort')}${CLIENT_SORTS[state.csort]}</button></div>
    <div id="clientList">${clientsListHtml()}</div>`;
}

function clientsListHtml() {
  const q = state.cquery.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const sorters = {
    recent: (a, b) => b.last - a.last,
    total: (a, b) => b.total - a.total,
    debt: (a, b) => b.debt - a.debt || b.last - a.last,
  };
  const list = clientStats()
    .filter(c => clientSeg(c, state.cseg))
    .filter(c => !q || c.name.toLowerCase().includes(q) || (digits.length >= 3 && String(c.phone).replace(/\D/g, '').includes(digits)))
    .sort(sorters[state.csort] || sorters.recent);
  if (!list.length) return emptyHtml('🤷', 'Никого не нашли', q ? 'Попробуйте часть имени или последние 4 цифры телефона' : 'В этой группе пока никого');
  const shown = list.slice(0, state.limit);
  const rest = list.length - shown.length;
  return `<p class="hint small" style="margin:0 4px 8px">${list.length} ${list.length % 10 === 1 && list.length % 100 !== 11 ? 'клиент' : 'клиентов'}${state.cseg === 'lost' ? ' — напишите им, чтобы вернуть' : ''}${!state.analytics ? ' · загружаю историю…' : ''}</p>
    <div class="list">${shown.map(clientCard).join('')}</div>` +
    (rest > 0 ? `<button class="btn" data-act="moreClients">Показать ещё ${Math.min(rest, PAGE)} из ${rest}</button>` : '');
}

// Строка клиента во вкладке «Клиенты»
function clientCard(c) {
  const lost = c.days > 60 && !c.active;
  const back = lost ? waLink(c.phone, fillText(state.texts.comeback || '', { client: c.name.split(' ')[0], no: '', debt: 0, track: '' })) : null;
  const sub = c.active ? `${ordersWord(c.count)} · ${c.active} в работе`
    : lost ? `${ordersWord(c.count)} · <span class="slow">не было ${daysWord(c.days)}</span>`
    : `${ordersWord(c.count)} · последний ${c.days === 0 ? 'сегодня' : daysWord(c.days) + ' назад'}`;
  const right = c.debt > 0 ? `<div class="debt money">${moneyShort(c.debt)}</div><div class="hint small">долг</div>`
    : back ? `<button class="rbtn sm wa-ic" data-act="open" data-url="${esc(back)}" aria-label="Написать">${icon('chat')}</button>`
    : `<div class="money">${moneyShort(c.total)}</div><div class="hint small">всего</div>`;
  return `
    <div class="lrow" data-act="openClient" data-key="${esc(c.key)}">
      <span class="ava">${esc(initials(c.name))}</span>
      <div class="grow">
        <div class="l1"><span class="name ellipsis">${esc(c.name)}</span>${c.vip ? `<span class="star">${icon('star')}</span>` : ''}${c.bday !== null && c.bday <= 7 ? `<span class="cake">${icon('cake')}</span>` : ''}${c.isNew ? '<span class="tag">впервые</span>' : ''}</div>
        <div class="l2">${sub}</div>
      </div>
      <div class="rt">${right}</div>
    </div>`;
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
  lines.push('');
  if (o.delivery > 0) lines.push(`Доставка: ${money(o.delivery)}`);
  if (o.discount > 0) lines.push(`Скидка: −${money(o.discount)}`);
  lines.push(`Итого: ${money(o.total)}`, `Оплачено: ${money(o.paid)}`);
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
  bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  insta: '<rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.6"/><path d="M16.8 7.2h.01"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
  sort: '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  repeat: '<path d="M4 12V9a3 3 0 0 1 3-3h13M17 3l3 3-3 3M20 12v3a3 3 0 0 1-3 3H4M7 21l-3-3 3-3"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 8"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  percent: '<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
  offline: '<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.5-2.8M19 13a10 10 0 0 0-2.4-1.7M2 9.5a15 15 0 0 1 4.3-2.6M22 9.5A15 15 0 0 0 11 5.6"/><path d="M12 20h.01"/>',
};

// «Алия С.» → «АС» — для кружка-аватарки
function initials(name) {
  const parts = String(name).replace(/[«»"@]/g, '').split(/\s+/).filter(Boolean);
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
