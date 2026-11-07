// Injected into the background amazon.com tab by background.js, which then
// calls brumiloAmazon.listOrders / readOrder there. Reads the orders placed on
// or after a date (YYYY-MM-DD):
//
//   1. listOrders - Your Orders, a year at a time, newest first, fetched
//      from inside amazon.com. Amazon encrypts what's on each order card
//      (it's decrypted by the page's own scripts as it loads), but the
//      card's data-csa-c-slot-id names the order, so the IDs can be read
//      without loading the pages.
//   2. readTransactions - Your Payments > Transactions, opened in the tab:
//      every card charge with its date, amount and order number, scrolled
//      for more until it's past the start date. Amazon charges once per
//      shipment, and these are what the bank statement shows.
//   3. readOrder - background.js opens each order's page in the tab; this
//      waits for Amazon to fill it in, then reads its date, items and Grand
//      Total. An order with no charges found (gift card) is matched on its
//      total.
//
// Amazon's pages aren't an API and change from time to time, so pages are
// read by data-component names and text patterns rather than exact layout.
(() => {
    const ORDER_ID = /\b(?:\d{3}|D\d{2})-\d{7}-\d{7}\b/;
    const LONG_DATE = '([A-Z][a-z]+ \\d{1,2}, \\d{4})';
    const PAUSE_MS = 700;
    const WAIT_FOR_PAGE_MS = 8000;
    const STALLS_BEFORE_GIVING_UP = 3;
    const SIGNED_OUT = 'signed-out';
    const BLOCKED = 'blocked';

    const pause = (ms = PAUSE_MS) => new Promise((resolve) => setTimeout(resolve, ms));
    const progress = (message) => chrome.runtime.sendMessage({ type: 'amazon-progress', message }).catch(() => {});
    const textOf = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const component = (root, name) => root.querySelector(`[data-component="${name}"]`);

    const isoDate = (text) => {
        const d = text ? new Date(text) : null;
        if (!d || Number.isNaN(d.getTime())) return null;
        return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
    };
    const toCents = (text) => Math.round(parseFloat(text.replace(/,/g, '')) * 100);

    // The nav bar's hidden sign-in form is on every page, signed in or not.
    const isSignInPage = (doc) => Boolean(doc.querySelector('#ap_email, #ap_password, form[name="signIn"]:not(#ap_navbar_form)'));
    const isRobotCheck = (doc) => Boolean(doc.querySelector('form[action*="validateCaptcha"]'));

    // Order IDs (and dates, where the card isn't encrypted) on one page of Your Orders.
    function listedOrders(doc) {
        const cards = [...doc.querySelectorAll('.order-card, .js-order-card')];
        if (cards.length === 0) {
            const ids = new Set(textOf(doc.body).match(new RegExp(ORDER_ID.source, 'g')) ?? []);
            return [...ids].map((id) => ({ id, date: null }));
        }
        return cards
            .map((card) => {
                const text = textOf(card);
                return {
                    id: card.getAttribute('data-csa-c-slot-id')?.match(ORDER_ID)?.[0] ?? text.match(ORDER_ID)?.[0],
                    date: isoDate(text.match(new RegExp(`Order placed\\s*${LONG_DATE}`, 'i'))?.[1]),
                };
            })
            .filter((order) => order.id);
    }

    // The page's text, a line per block - so the older invoice's "1 of: Desk
    // Lamp" lines can be picked out. Changes the document; pass a copy.
    function textLines(doc) {
        doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
        doc.querySelectorAll('br, p, div, tr, td, th, li, h1, h2, h3, h4, h5, h6').forEach((n) => n.append('\n'));
        return (doc.body?.textContent ?? '')
            .split('\n')
            .map((line) => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    }

    // An order's page (Order Details / Order Summary), or null if it can't
    // be read. Its parts carry data-component names; the older printable
    // invoice is read by its text.
    function parseOrder(doc, orderId, listedDate = null) {
        const items = [...doc.querySelectorAll('[data-component="purchasedItems"]')]
            .map((item) => ({
                name: textOf(component(item, 'itemTitle')).slice(0, 500),
                // The count badge on the item's picture, if more than one.
                quantity: Math.max(1, parseInt((textOf(item.querySelector('.od-item-view-qty')) || textOf(component(item, 'quantity'))).match(/\d+/)?.[0] ?? '1', 10)),
            }))
            .filter((item) => item.name);
        const placed = isoDate(textOf(component(doc, 'orderDate')).match(new RegExp(LONG_DATE))?.[1]);
        const totalRow = [...doc.querySelectorAll('.od-line-item-row')].find((row) => /Grand Total/i.test(row.textContent));
        const rowTotal = textOf(totalRow).match(/\$([\d,]+\.\d{2})/);

        const lines = textLines(doc.cloneNode(true));
        const text = lines.join('\n');
        const flat = lines.join(' ');

        if (items.length === 0) {
            for (const line of lines) {
                const item = line.match(/^(\d+) of:\s*(.+)$/);
                if (item) items.push({ name: item[2].slice(0, 500), quantity: Math.max(1, parseInt(item[1], 10)) });
            }
        }

        // "Visa ending in 1234: October 3, 2026: $45.67" - refunds (negative) left out.
        const charges = [];
        for (const charge of flat.matchAll(new RegExp(`ending in \\d{4}\\s*:\\s*${LONG_DATE}\\s*:\\s*(-?)\\$([\\d,]+\\.\\d{2})`, 'g'))) {
            const date = isoDate(charge[1]);
            const cents = toCents(charge[3]);
            if (date && charge[2] !== '-' && cents > 0) charges.push({ date, cents });
        }

        const total = rowTotal ?? flat.match(/Grand Total:\s*\$([\d,]+\.\d{2})/i);
        const orderDate = placed ?? isoDate(text.match(new RegExp(`Order Placed:\\s*${LONG_DATE}`, 'i'))?.[1]) ?? listedDate;

        if (!orderDate || items.length === 0) return null;
        return { order_id: orderId, order_date: orderDate, total_cents: total ? toCents(total[1]) : null, charges, items };
    }

    // Returns { orders: [{ id, date }], log } newest first, { signedOut } or { blocked }.
    async function listOrders(since) {
        const log = [];
        async function load(path) {
            const response = await fetch(path, { credentials: 'include' });
            if (response.url.includes('/ap/signin')) throw new Error(SIGNED_OUT);
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            log.push(`${response.status} ${path} - ${doc.title.trim() || '(no title)'}`);
            if (isSignInPage(doc)) throw new Error(SIGNED_OUT);
            if (isRobotCheck(doc)) throw new Error(BLOCKED);
            if (!response.ok) throw new Error(`Amazon answered ${response.status}`);
            return doc;
        }

        try {
            if (location.pathname.startsWith('/ap/') || isSignInPage(document)) return { signedOut: true, log };

            const listed = new Map();
            const sinceYear = parseInt(since.slice(0, 4), 10);
            let reachedSince = false;
            for (let year = new Date().getFullYear(); year >= sinceYear && !reachedSince; year--) {
                for (let start = 0; ; start += 10) {
                    progress(`Finding ${year} orders… (${listed.size} so far)`);
                    const found = listedOrders(await load(`/your-orders/orders?timeFilter=year-${year}&startIndex=${start}`));
                    const fresh = found.filter((order) => !listed.has(order.id));
                    fresh.forEach((order) => listed.set(order.id, order.date));
                    log.push(`  ${found.length} orders on the page, ${fresh.length} new`);
                    await pause();

                    const dates = found.map((order) => order.date).filter(Boolean).sort();
                    if (dates.length && dates[0] < since) reachedSince = true;
                    if (fresh.length === 0 || reachedSince) break;
                }
            }

            const orders = [...listed].filter(([, date]) => !date || date >= since).map(([id, date]) => ({ id, date }));
            return { orders, log };
        } catch (e) {
            if (e.message === SIGNED_OUT) return { signedOut: true, log };
            if (e.message === BLOCKED) return { blocked: true, log };
            throw e;
        }
    }

    // Reads the order page open in this tab, once Amazon has filled it in.
    // Returns { order } (null if it couldn't be read), { signedOut } or { blocked }.
    async function readOrder(orderId, listedDate) {
        if (location.pathname.startsWith('/ap/') || isSignInPage(document)) return { signedOut: true };
        if (isRobotCheck(document)) return { blocked: true };

        const filledIn = () => document.querySelector('[data-component="purchasedItems"] [data-component="itemTitle"]') || / of:\s/.test(document.body?.textContent ?? '');
        for (let waited = 0; !filledIn() && waited < WAIT_FOR_PAGE_MS; waited += 250) {
            await pause(250);
        }

        return { order: parseOrder(document, orderId, listedDate) };
    }

    // The card charges on the transactions page as it stands:
    // [{ date, cents, orderId }]. Refunds, declines and charges covering
    // several orders at once are left out.
    function listedCharges(doc) {
        return [...doc.querySelectorAll('[data-testid="transaction-link-content-wrapper"]')]
            .map((entry) => {
                const texts = [...entry.querySelectorAll('[data-testid="text"]')].map(textOf);
                const orderIds = textOf(entry).match(new RegExp(ORDER_ID.source, 'g')) ?? [];
                const amount = texts.map((t) => t.match(/^(-?)\$([\d,]+\.\d{2})$/)).find(Boolean);
                const date = isoDate(texts.find((t) => /^[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}$/.test(t)));
                const charged = texts.some((t) => /^charged$/i.test(t));
                return { date, orderIds, cents: amount && amount[1] === '-' ? toCents(amount[2]) : 0, charged };
            })
            .filter((t) => t.date)
            .map((t) => ({ date: t.date, cents: t.charged && t.orderIds.length === 1 ? t.cents : 0, orderId: t.orderIds.length === 1 ? t.orderIds[0] : null }));
    }

    // Scrolls to the last charge listed so far: the window, and any panel around
    // the charges that scrolls on its own (window.scrollTo does nothing to those),
    // then the last charge itself into view.
    function scrollToEnd() {
        const rows = document.querySelectorAll('[data-testid="transaction-link-content-wrapper"]');
        const last = rows[rows.length - 1];
        const panels = new Set([document.scrollingElement ?? document.documentElement]);
        for (let el = last?.parentElement; el; el = el.parentElement) {
            if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) panels.add(el);
        }
        panels.forEach((panel) => {
            panel.scrollTop = 0;
            panel.scrollTop = panel.scrollHeight;
        });
        last?.scrollIntoView({ block: 'end' });
        last?.dispatchEvent(new WheelEvent('wheel', { deltaY: 800, bubbles: true }));
    }

    // Reads the transactions page open in this tab, scrolling to load more
    // until it reaches charges from before `since` or runs out. Returns
    // { charges: [{ date, cents, orderId }], oldest }, { signedOut } or { blocked }.
    async function readTransactions(since) {
        if (location.pathname.startsWith('/ap/') || isSignInPage(document)) return { signedOut: true };
        if (isRobotCheck(document)) return { blocked: true };

        const count = () => document.querySelectorAll('[data-testid="transaction-link-content-wrapper"]').length;
        for (let waited = 0; count() === 0 && waited < WAIT_FOR_PAGE_MS; waited += 250) {
            await pause(250);
        }

        // A slow load looks like the end of the list, so a stall is tried a few
        // times - nudging the page again each time - before it's taken as one.
        let stalls = 0;
        for (let rounds = 0; rounds < 300; rounds++) {
            const listed = listedCharges(document);
            const oldest = listed.map((t) => t.date).sort()[0];
            progress(`Reading card charges… (back to ${oldest ?? 'now'})`);
            if (listed.length === 0 || oldest < since) break;

            const before = count();
            const more = [...document.querySelectorAll('button, [role="button"], a')].find((el) => /^next page$/i.test(textOf(el)));
            if (more) more.click();
            scrollToEnd();
            // For a page that listens for the wheel or scroll rather than watching what's in view.
            document.dispatchEvent(new WheelEvent('wheel', { deltaY: 800, bubbles: true }));
            window.dispatchEvent(new Event('scroll'));
            document.querySelector('[data-testid="LoadingViewFacadeTestID"]')?.scrollIntoView();

            let waited = 0;
            while (count() === before && waited < WAIT_FOR_PAGE_MS) {
                await pause(300);
                waited += 300;
            }
            if (count() > before) {
                stalls = 0;
            } else if (++stalls >= STALLS_BEFORE_GIVING_UP) {
                break;
            }
        }

        // `oldest` is how far back the page got - past `since`, or short of it.
        const oldest = listedCharges(document).map((t) => t.date).sort()[0] ?? null;
        return { charges: listedCharges(document).filter((t) => t.cents > 0 && t.orderId && t.date >= since), oldest };
    }

    globalThis.brumiloAmazon = { listOrders, readTransactions, readOrder, parseOrder, listedOrders, listedCharges };
})();
