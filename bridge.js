// Runs on the Brumilo web app. Answers the page's messages (see
// webapp/resources/js/Components/Accounting/amazonExtension.js) and hands
// syncs to the service worker, passing its progress and result back.
const PAGE = 'brumilo-page';
const EXTENSION = 'brumilo-extension';

function reply(message) {
    window.postMessage({ source: EXTENSION, ...message }, window.location.origin);
}

// Reloading or updating the extension cuts this copy of the script off from
// it (chrome.runtime.id goes away) until the page is reloaded.
function connected() {
    try {
        return Boolean(chrome.runtime?.id);
    } catch {
        return false;
    }
}

window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin || e.data?.source !== PAGE) return;
    const { type, id, since, open } = e.data;

    if (!connected()) {
        if (type === 'amazon-sync') {
            reply({ type: 'error', id, error: 'reload', message: 'The Brumilo extension was updated - refresh this page, then sync again.' });
        }
        return;
    }

    if (type === 'hello') {
        reply({ type: 'hello', version: chrome.runtime.getManifest().version });
        return;
    }

    if (type === 'amazon-sync') {
        let finished = false;
        let port;
        try {
            port = chrome.runtime.connect({ name: 'amazon-sync' });
        } catch {
            reply({ type: 'error', id, error: 'reload', message: 'The Brumilo extension was updated - refresh this page, then sync again.' });
            return;
        }
        port.onMessage.addListener((message) => {
            reply({ ...message, id });
            if (message.type === 'done' || message.type === 'error') {
                finished = true;
                port.disconnect();
            }
        });
        port.onDisconnect.addListener(() => {
            if (!finished) {
                reply({ type: 'error', id, error: 'stopped', message: 'The extension stopped before it finished. Try again.' });
            }
        });
        port.postMessage({ since, open });
    }
});
