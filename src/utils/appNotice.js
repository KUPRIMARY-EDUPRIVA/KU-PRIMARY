const NOTICE_ID = 'app-feedback-notice';

export function showAppNotice(message, type = 'info') {
    let notice = document.getElementById(NOTICE_ID);
    if (!notice) {
        notice = document.createElement('div');
        notice.id = NOTICE_ID;
        notice.setAttribute('role', 'status');
        notice.setAttribute('aria-live', 'polite');
        notice.style.cssText = [
            'position:fixed',
            'right:20px',
            'bottom:20px',
            'z-index:10000',
            'display:flex',
            'align-items:center',
            'gap:14px',
            'max-width:min(440px,calc(100vw - 32px))',
            'padding:14px 16px',
            'border:1px solid #dbe2ea',
            'border-radius:10px',
            'background:#fff',
            'color:#1f2937',
            'box-shadow:0 8px 24px rgba(15,23,42,.16)',
            'font:500 14px/1.45 system-ui,sans-serif',
        ].join(';');

        const text = document.createElement('span');
        text.dataset.noticeMessage = 'true';
        text.style.flex = '1';

        const close = document.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.textContent = '×';
        close.style.cssText = 'border:0;background:transparent;color:#64748b;font-size:22px;line-height:1;cursor:pointer;padding:0 2px;';
        close.addEventListener('click', () => notice.remove());

        notice.append(text, close);
        document.body.appendChild(notice);
    }

    const text = notice.querySelector('[data-notice-message]');
    text.textContent = String(message || '');
    notice.style.borderLeft = `4px solid ${
        { success: '#16a34a', error: '#dc2626', warning: '#d97706', info: '#2563eb' }[type] || '#2563eb'
    }`;
    notice.setAttribute('role', type === 'error' ? 'alert' : 'status');
}
