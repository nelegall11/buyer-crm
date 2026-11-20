'use strict';

// =====================================================================
//  ДЕМО-«СЕРВЕР»
//  Притворяется Google-таблицей, чтобы приложение можно было открыть
//  просто в браузере и показать байеру. Генерирует 100 выдуманных заказов
//  за последние 2 месяца. Все имена, телефоны и магазины выдуманы.
//  Изменения хранятся только в этом браузере (localStorage).
//  На этапе 2 вместо этого файла приложение будет ходить в Apps Script.
// =====================================================================

const DemoServer = (() => {
  const KEY = 'buyercrm-demo-v5';
  const ORDER_COUNT = 100;
  const ARCHIVE_DAYS = 30; // выданные заказы старше 30 дней без долга не загружаем сразу

  const SETTINGS = {
    shopName: 'Shop & Go (демо)',
    usd: 520,
    eur: 565,
    retail: 25,
    opt: 15,
    round: 100,
    // Через сколько дней заказ попадает в «Требует внимания»
    attention: { wait: 3, paid: 3, way: 25, arrived: 5 },
  };

  const STATUSES = ['Ждёт оплаты', 'Оплачен', 'Выкуплен', 'На складе форвардера', 'В пути', 'Прибыл', 'Выдан', 'Отменён'];
  const [WAIT, PAID, BOUGHT, STOCK, WAY, ARRIVED, DONE, CANCEL] = STATUSES.map((_, i) => i);

  // Тексты сообщений клиентам. Вместо {client}, {no} и т.д. подставляются данные заказа.
  // {track_line} — строка с трек-номером (если он есть), {debt_line} — строка с доплатой (если есть долг).
  const TEXTS = {
    paid: 'Здравствуйте, {client}! Оплата за заказ №{no} получена, спасибо 🙏 Начинаем выкуп.',
    bought: 'Здравствуйте, {client}! Заказ №{no} выкуплен ✅ Как только он отправится в Казахстан — сообщим.',
    stock: 'Здравствуйте, {client}! Заказ №{no} уже на складе, скоро отправка 📦',
    way: 'Здравствуйте, {client}! Заказ №{no} в пути 🚚{track_line}',
    arrived: 'Здравствуйте, {client}! Заказ №{no} прибыл 🎉 Можно забирать.{debt_line}',
    done: '{client}, спасибо за заказ! Будем рады видеть вас снова 💛',
    remind: 'Здравствуйте, {client}! Напоминаем про оплату по заказу №{no}: осталось {debt}. Спасибо 🙏',
  };

  // ---------- Выдуманные клиенты и магазины ----------

  const NAMES = ['Алия С.', 'Дана К.', 'Марат А.', 'Сауле Ж.', 'Ирина Л.', 'Ерлан Б.', 'Асель О.', 'Айгерим Т.',
    'Тимур Н.', 'Мадина Р.', 'Нурлан Е.', 'Камила Д.', 'Арман С.', 'Жанна П.', 'Олжас М.', 'Динара А.',
    'Руслан К.', 'Гульнара И.', 'Самал Б.', 'Бекзат Ж.', 'Аружан Т.', 'Ольга В.', 'Виктория Ш.', 'Ержан У.',
    'Томирис Ж.', 'Айдана К.', 'Санжар Ы.', 'Лаура М.', 'Ксения Г.', 'Азамат Р.'];
  const WHOLESALE = ['ИП «Мини Маркет»', 'ИП «Детский уголок»'];
  const OPERATORS = ['701', '702', '705', '707', '708', '747', '777'];

  // [домен, начало ссылки, товары [название, цена], размеры, валюта]
  const SHOPS = [
    ['https://www.northwear-demo.com/p/', [['denim-jacket', 89], ['basic-hoodie', 45], ['wool-coat', 180], ['linen-shirt', 39], ['cargo-pants', 59]],
      ['XS', 'S', 'M', 'L', 'XL', 'M · чёрный', 'L · серый'], '$'],
    ['https://urbanstep-demo.com/products/', [['runner-x-white', 120], ['chelsea-boot', 140], ['canvas-low', 65]],
      ['36', '37', '38', '39', '40', '41', '42', '43', '44'], '$'],
    ['https://www.lunabags-demo.eu/shop/', [['mini-tote', 79], ['card-holder', 35], ['crossbody', 110]],
      ['чёрный', 'бежевый', 'коричневый', ''], '€'],
    ['https://kidsmile-demo.com/item/', [['pajama-set', 19.9], ['rain-jacket', 34], ['kids-sneakers', 42]],
      ['98 см', '104 см', '110 см', '116 см', '122 см'], '$'],
    ['https://sportzone-demo.store/i/', [['training-socks-3pack', 12], ['running-tee', 25], ['yoga-leggings', 48]],
      ['S', 'M', 'L'], '$'],
    ['https://glowbeauty-demo.com/p/', [['vitamin-c-serum', 38], ['lip-balm-set', 22], ['sunscreen-spf50', 29]],
      [''], '$'],
  ];

  let db = null;

  // ---------- Генерация 100 заказов ----------

  // Генератор «случайных» чисел, который всегда выдаёт одно и то же — чтобы демо было одинаковым у всех
  function makeRandom(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function build() {
    const r = makeRandom(42);
    const pick = arr => arr[Math.floor(r() * arr.length)];
    const data = { settings: { ...SETTINGS }, orders: [], nextNo: ORDER_COUNT + 1, nextItemId: 1 };
    const clients = NAMES.map((name, i) => [name, `8 ${OPERATORS[i % OPERATORS.length]} 555 ${String(10 + i).padStart(2, '0')} ${String(11 + i * 3).slice(-2)}`]);
    const wholesale = WHOLESALE.map((name, i) => [name, `8 727 555 9${i} 0${i}`]);

    for (let no = 1; no <= ORDER_COUNT; no++) {
      const daysAgo = Math.max(0, Math.round((ORDER_COUNT - no) * 0.6 + (r() - 0.5) * 2));
      const opt = r() < 0.08;
      const [client, phone] = opt ? pick(wholesale) : pick(clients);
      const markup = opt ? 15 : (r() < 0.85 ? 25 : 20);

      // Чем старше заказ, тем дальше он продвинулся
      const x = r();
      let status;
      if (daysAgo <= 1) status = x < 0.5 ? WAIT : PAID;
      else if (daysAgo <= 5) status = x < 0.15 ? WAIT : x < 0.6 ? PAID : BOUGHT;
      else if (daysAgo <= 12) status = x < 0.15 ? PAID : x < 0.5 ? BOUGHT : STOCK;
      else if (daysAgo <= 22) status = x < 0.25 ? STOCK : WAY;
      else if (daysAgo <= 32) status = x < 0.3 ? WAY : x < 0.65 ? ARRIVED : DONE;
      else status = x < 0.07 ? ARRIVED : x < 0.95 ? DONE : CANCEL;
      if (daysAgo > 3 && r() < 0.03) status = CANCEL;

      // Товары: обычно из одного магазина
      const shop = pick(SHOPS);
      const n = r() < 0.6 ? 1 : r() < 0.75 ? 2 : 3;
      const raw = [];
      for (let k = 0; k < n; k++) {
        const s = k > 0 && r() < 0.3 ? pick(SHOPS) : shop;
        const [base, products, sizes, currency] = s;
        const [slug, price] = pick(products);
        raw.push({
          link: `${base}${slug}-${1000 + Math.floor(r() * 9000)}`,
          size: opt ? pick(sizes) + (r() < 0.5 ? ', ' + pick(sizes) : '') : pick(sizes),
          qty: opt ? 5 + Math.floor(r() * 16) : (r() < 0.85 ? 1 : 2),
          amount: price, currency,
        });
      }

      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(9 + Math.floor(r() * 12), Math.floor(r() * 60), 0, 0);
      // Когда заказ получил текущий статус (чтобы видеть, что он «застрял»)
      const k = [0, 0.3, 0.5, 0.4, 0.85, 0.15, 0.5, 0.5][status];
      const statusAt = new Date(Date.now() - Math.round(daysAgo * k) * 86400000 - 3600000);
      const o = {
        no, date: date.toISOString(), client, phone, opt, comment: '', paid: 0,
        status: STATUSES[status], statusAt: statusAt.toISOString(), snoozeUntil: '',
        // Заказы, отправленные в одни дни, едут одной посылкой — у них общий трек-номер
        track: status >= WAY && status <= DONE ? `DM${100000000 + Math.floor(daysAgo / 4) * 7919}US` : '',
        items: raw.map(it => {
          const bought = (status >= BOUGHT && status !== CANCEL) || (status === PAID && r() < 0.3);
          return makeItem(data, it, markup, it.currency === '€' ? data.settings.eur : data.settings.usd, bought);
        }),
      };
      recalc(o);

      // Оплата: обычно всё сразу, иногда часть
      if (status === WAIT || status === CANCEL) o.paid = 0;
      else if (r() < (status === DONE ? 0.96 : 0.75)) o.paid = o.total;
      else o.paid = Math.round(o.total * (0.3 + r() * 0.4) / 1000) * 1000;
      recalc(o);
      data.orders.push(o);
    }
    return data;
  }

  // Та же формула, что в боте: себестоимость × (1 + наценка) с округлением вверх
  function makeItem(data, x, markup, rate, bought) {
    const qty = Math.max(1, Math.round(Number(x.qty) || 1));
    const amount = Number(x.amount) || 0;
    const cost = qty * amount * rate;
    return {
      id: data.nextItemId++,
      link: String(x.link || ''), size: String(x.size || ''), qty, amount,
      currency: x.currency === '€' ? '€' : '$', rate, markup,
      cost, price: calcPrice(cost, markup, data.settings.round), bought: !!bought,
    };
  }

  function recalc(o) {
    o.count = o.items.reduce((a, x) => a + x.qty, 0);
    o.total = o.items.reduce((a, x) => a + x.price, 0);
    o.profit = o.items.reduce((a, x) => a + x.price - x.cost, 0);
    o.debt = o.total - o.paid;
  }

  function find(no) {
    const o = db.orders.find(x => x.no === Number(no));
    if (!o) throw new Error(`Заказ №${no} не найден`);
    return o;
  }

  // Старый закрытый заказ без долга — в «архиве»: не загружаем при открытии, находится поиском
  function isArchived(o) {
    const i = STATUSES.indexOf(o.status);
    const age = (Date.now() - new Date(o.date)) / 86400000;
    return (i === DONE || i === CANCEL) && age > ARCHIVE_DAYS && (i === CANCEL || o.debt <= 0);
  }

  function clientKey(o) {
    return o.phone.replace(/\D/g, '').slice(-10) || o.client.toLowerCase();
  }

  // ---------- Действия (на этапе 2 такие же будут в Apps Script) ----------

  const actions = {
    init() {
      const archived = db.orders.filter(isArchived);
      const now = new Date();
      const thisMonth = archived.filter(o => {
        const d = new Date(o.date);
        return STATUSES.indexOf(o.status) !== CANCEL && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
      // Все клиенты из всех заказов — для подсказок в форме нового заказа
      const clients = new Map();
      db.orders.forEach(o => {
        const k = clientKey(o);
        if (!clients.has(k)) clients.set(k, { name: o.client, phone: o.phone, count: 0, last: 0 });
        const c = clients.get(k);
        c.count++;
        if (o.no > c.last) { c.last = o.no; c.name = o.client; c.phone = o.phone; }
      });
      return {
        settings: db.settings, statuses: STATUSES, texts: TEXTS, demo: true,
        orders: db.orders.filter(o => !isArchived(o)),
        archived: archived.length,
        // Итоги месяца по незагруженным заказам — чтобы «Сводка» считала правильно
        monthArchived: {
          count: thisMonth.length,
          total: thisMonth.reduce((a, o) => a + o.total, 0),
          profit: thisMonth.reduce((a, o) => a + o.profit, 0),
        },
        clients: [...clients.values()].sort((a, b) => b.last - a.last),
      };
    },

    // Поиск по всем заказам, включая архив
    search({ q }) {
      const text = String(q || '').toLowerCase().trim().replace('№', '');
      const digits = text.replace(/\D/g, '');
      if (text.length < 2) return { orders: [] };
      const found = db.orders.filter(o =>
        o.client.toLowerCase().includes(text) ||
        String(o.no) === text ||
        (digits.length >= 3 && o.phone.replace(/\D/g, '').includes(digits)));
      return { orders: found.slice(-50) };
    },

    // Все заказы одного клиента, включая архив
    clientOrders({ key }) {
      return { orders: db.orders.filter(o => clientKey(o) === key) };
    },

    createOrder({ order }) {
      const client = String(order.client || '').trim();
      if (!client) throw new Error('Не указан клиент');
      const items = (order.items || []).filter(x => Number(x.amount) > 0);
      if (!items.length) throw new Error('Добавьте хотя бы один товар с ценой');
      const rates = { '$': Number(order.rates.usd) || 0, '€': Number(order.rates.eur) || 0 };
      const markup = Number(order.markup) || 0;

      const o = {
        no: db.nextNo++, date: new Date().toISOString(), client, phone: String(order.phone || '').trim(),
        opt: !!order.opt, track: '', comment: '', paid: 0,
        items: items.map(x => {
          const rate = rates[x.currency === '€' ? '€' : '$'];
          if (!(rate > 0)) throw new Error(`Не указан курс ${x.currency}`);
          return makeItem(db, x, markup, rate, false);
        }),
      };
      recalc(o);
      o.paid = order.paidAll ? o.total : Math.max(0, Number(order.paid) || 0);
      o.status = o.paid > 0 ? STATUSES[PAID] : STATUSES[WAIT];
      o.statusAt = o.date;
      o.snoozeUntil = '';
      recalc(o);
      db.orders.push(o);

      // Запоминаем курс как «прошлый», как это делает бот
      if (items.some(x => x.currency !== '€')) db.settings.usd = rates['$'];
      if (items.some(x => x.currency === '€')) db.settings.eur = rates['€'];
      return { orders: [o], settings: db.settings };
    },

    setStatus({ nos, status, track }) {
      if (!STATUSES.includes(status)) throw new Error('Неизвестный статус');
      const changed = [].concat(nos).map(find);
      changed.forEach(o => {
        if (o.status !== status) o.statusAt = new Date().toISOString();
        o.status = status;
        if (status === STATUSES[BOUGHT]) o.items.forEach(x => { x.bought = true; });
        if (track) o.track = String(track).trim();
      });
      return { orders: changed };
    },

    addPayment({ no, amount }) {
      const o = find(no);
      const n = Number(amount);
      if (!(n > 0)) throw new Error('Сумма должна быть больше нуля');
      o.paid += n;
      if (o.status === STATUSES[WAIT]) { o.status = STATUSES[PAID]; o.statusAt = new Date().toISOString(); }
      recalc(o);
      return { orders: [o] };
    },

    // Галочка «Выкуплен» у товара. Все товары отмечены → заказ сам становится «Выкуплен»
    setBought({ no, itemId, bought }) {
      const o = find(no);
      const item = o.items.find(x => x.id === Number(itemId));
      if (!item) throw new Error('Товар не найден');
      item.bought = !!bought;
      const was = o.status;
      if (o.status === STATUSES[PAID] && o.items.every(x => x.bought)) o.status = STATUSES[BOUGHT];
      else if (o.status === STATUSES[BOUGHT] && !item.bought) o.status = STATUSES[PAID];
      if (o.status !== was) o.statusAt = new Date().toISOString();
      return { orders: [o] };
    },

    saveTrack({ no, track }) {
      const o = find(no);
      o.track = String(track || '').trim();
      return { orders: [o] };
    },

    // Выдача клиенту: несколько заказов сразу становятся «Выдан», доплата — по желанию
    handover({ nos, paid }) {
      const changed = [].concat(nos).map(find);
      changed.forEach(o => {
        if (paid && o.debt > 0) o.paid = o.total;
        o.status = STATUSES[DONE];
        o.statusAt = new Date().toISOString();
        recalc(o);
      });
      return { orders: changed };
    },

    // «Напомнили клиенту» — не показывать заказ в «Требует внимания» несколько дней
    snooze({ no, days }) {
      const o = find(no);
      o.snoozeUntil = new Date(Date.now() + (Number(days) || 2) * 86400000).toISOString();
      return { orders: [o] };
    },

    // Кнопка «Отменить»: вернуть заказы в то состояние, которое было до действия
    restore({ orders }) {
      const restored = [].concat(orders).map(saved => {
        const o = find(saved.no);
        ['status', 'statusAt', 'paid', 'track', 'snoozeUntil'].forEach(f => { o[f] = saved[f]; });
        o.items.forEach(it => {
          const was = (saved.items || []).find(x => x.id === it.id);
          if (was) it.bought = was.bought;
        });
        recalc(o);
        return o;
      });
      return { orders: restored };
    },

    resetDemo() {
      db = build();
      return actions.init();
    },
  };

  function load() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) { db = JSON.parse(saved); return; }
    } catch (e) { /* в приватном режиме хранилище может быть недоступно — не страшно */ }
    db = build();
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* см. выше */ }
  }

  return {
    // Отвечает с небольшой задержкой, как настоящий сервер
    handle(action, data) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            if (!db) load();
            const fn = actions[action];
            if (!fn) throw new Error('Неизвестное действие: ' + action);
            const out = fn(data || {});
            save();
            resolve(JSON.parse(JSON.stringify(out)));
          } catch (err) {
            reject(err);
          }
        }, 250);
      });
    },
  };
})();
