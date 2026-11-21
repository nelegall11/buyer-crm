'use strict';

// =====================================================================
//  БЫСТРАЯ СТРОКА: «мария nike.com 10us black 120$» → клиент и товары.
//  Без ИИ, простыми правилами. Такой же код — в apps-script/Quick.gs
//  (бот разбирает строку так же). Меняете один файл — поменяйте и второй.
//
//  Клиент — в начале: имя, телефон или @ник из Instagram (можно вместе).
//  Товар — магазин или ссылка, размер/цвет, цена со значком валюты
//  (120$, $120, 95€, 45000тг), количество x2. Каждый товар — с новой строки.
//  «опт» — оптовая наценка, «оплачено» — клиент уже заплатил.
// =====================================================================

function parseQuick(text) {
  const out = { name: '', phone: '', instagram: '', items: [], problems: [], opt: false, paid: false };
  let src = String(text || '').replace(/\r/g, '');

  // Телефон: +7 707 123 45 67, 87071234567, 8 (707) 123-45-67
  const ph = src.match(/(?:\+?7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/);
  if (ph) { out.phone = ph[0].trim(); src = src.replace(ph[0], ' '); }
  // Instagram: @ник или ссылка instagram.com/ник
  const ig = src.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([\w.]{2,30})\/?/i) || src.match(/(?:^|\s)@([\w.]{2,30})/);
  if (ig) { out.instagram = ig[1].replace(/\.+$/, '').toLowerCase(); src = src.replace(ig[0], ' '); }

  const LINK = /^(https?:\/\/\S+|(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?)$/i;
  const PRICE = /^([$€])?(\d+(?:[.,]\d{1,2})?)(\$|€|usd|eur|евро|тг|₸|kzt|тенге)?$/i;
  const CUR = /^(\$|€|usd|eur|евро|тг|₸|kzt|тенге)$/i;
  const QTY = /^(?:[xх×*](\d{1,3})|(\d{1,3})(?:шт|pcs))$/i;
  const curOf = sign => {
    const s = sign.toLowerCase();
    return s === '€' || s === 'eur' || s === 'евро' ? '€' : s === '$' || s === 'usd' ? '$' : '₸';
  };

  const nameWords = [];
  let clientDone = false;
  let cur = null;
  const startItem = () => { cur = { link: '', words: [], qty: 1, amount: 0, currency: '' }; out.items.push(cur); };

  src.split(/\n|;/).forEach((line, li) => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    cur = null; // новая строка — новый товар
    words.forEach(w => {
      const t = w.replace(/[,.]+$/, '');
      const low = t.toLowerCase();
      if (low === 'опт') { out.opt = true; return; }
      if (/^оплач|^оплатил/.test(low)) { out.paid = true; return; }
      if (LINK.test(t) && !/^\d+([.,]\d+)?$/.test(t)) {
        clientDone = true;
        if (!cur || cur.link) startItem();
        cur.link = /^https?:/i.test(t) ? t : 'https://' + t;
        return;
      }
      const p = t.match(PRICE);
      if (p && (p[1] || p[3])) {
        clientDone = true;
        if (!cur) startItem();
        cur.amount = parseFloat(p[2].replace(',', '.'));
        cur.currency = curOf(p[1] || p[3]);
        return;
      }
      // «120 $» — цена и значок через пробел
      if (CUR.test(t) && cur && cur.words.length && /^\d+([.,]\d+)?$/.test(cur.words[cur.words.length - 1])) {
        cur.amount = parseFloat(cur.words.pop().replace(',', '.'));
        cur.currency = curOf(t);
        return;
      }
      const q = t.match(QTY);
      if (q && cur) { cur.qty = Number(q[1] || q[2]) || 1; return; }
      if (!clientDone) { nameWords.push(t); return; }
      if (!cur) startItem();
      cur.words.push(t);
    });
    // Первая строка без магазина и цены — это клиент, дальше идут товары
    if (li === 0) clientDone = true;
  });

  out.name = nameWords.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  out.items = out.items
    .map(x => ({ link: x.link, size: x.words.join(' '), qty: x.qty, amount: x.amount, currency: x.currency || '$' }))
    .filter(x => x.link || x.size || x.amount);
  out.items.forEach((x, i) => {
    if (!(x.amount > 0)) out.problems.push(`нет цены у товара ${out.items.length > 1 ? i + 1 : ''}`.trim());
  });
  if (!out.items.length) out.problems.push('не нашла товар — напишите магазин или ссылку и цену');
  if (!out.name && !out.phone && !out.instagram) out.problems.push('не указан клиент — имя, телефон или @ник в начале');
  return out;
}
