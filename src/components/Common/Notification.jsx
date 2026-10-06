import React, { useState } from 'react';

export default function Notification({ message, type = 'info' }) {
    const [visible, setVisible] = useState(true);

    if (!visible) return null;

    const colors = {
        success: '#27ae60',
        error: '#e74c3c',
        warning: '#f39c12',
        info: '#3498db'
    };

    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };

    const style = {
        position: 'fixed',
        top: '20px',
        right: '20px',
        background: colors[type] || colors.info,
        color: 'white',
        padding: '15px 20px',
        borderRadius: '8px',
        boxShadow: '0 5px 15px rgba(0,0,0,0.2)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        animation: 'slideIn 0.3s ease',
        maxWidth: '400px'
    };

    return (
        <div style={style} role={type === 'error' ? 'alert' : 'status'}>
            <i className={`fas ${icons[type] || icons.info}`}></i>
            <span>{message}</span>
            <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => setVisible(false)}
                style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'white', fontSize: 20, cursor: 'pointer' }}
            >
                ×
            </button>
        </div>
    );
}
