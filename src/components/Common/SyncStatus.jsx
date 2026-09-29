// src/components/Common/SyncStatus.jsx
import React from 'react';
import { useSync } from '../../context/SyncContext';

export default function SyncStatus() {
    const { isOnline, isSyncing, pendingCount, lastSync, processSyncQueue } = useSync();

    const formatTime = (date) => {
        if (!date) return 'Never';
        const diff = Math.floor((new Date() - date) / 60000);
        if (diff < 1) return 'Just now';
        if (diff < 60) return `${diff} minutes ago`;
        if (diff < 1440) return `${Math.floor(diff / 60)} hours ago`;
        return `${Math.floor(diff / 1440)} days ago`;
    };

    return (
        <div
            className="sync-status"
            title={isOnline ? 'Online' : 'Offline'}
            aria-label={isOnline ? 'Online' : 'Offline'}
            style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 12px',
            borderRadius: '20px',
            background: isOnline ? 'var(--light)' : '#fff3cd',
            border: isOnline ? 'none' : '1px solid var(--warning)',
            fontSize: '12px',
            fontWeight: '500',
            color: isOnline ? 'var(--success)' : '#856404'
        }}>
            {isSyncing ? (
                <>
                    <i className="fas fa-sync-alt fa-spin"></i>
                    <span>Syncing...</span>
                </>
            ) : (
                <>
                    <i className={`fas ${isOnline ? 'fa-wifi' : 'fa-wifi-slash'}`}></i>
                    <span className="sync-status-label">{isOnline ? 'Online' : 'Offline'}</span>
                </>
            )}
            
            {pendingCount > 0 && (
                <span className="sync-status-pending" style={{
                    background: 'var(--warning)',
                    color: 'white',
                    padding: '1px 8px',
                    borderRadius: '12px',
                    fontSize: '10px',
                    fontWeight: '600'
                }}>
                    {pendingCount} pending
                </span>
            )}
            
            {lastSync && isOnline && (
                <span className="sync-status-time" style={{ color: 'var(--gray)', fontSize: '10px' }}>
                    {formatTime(lastSync)}
                </span>
            )}

            {isOnline && pendingCount > 0 && (
                <button
                    onClick={processSyncQueue}
                    disabled={isSyncing}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--primary)',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: '600',
                        padding: '2px 8px',
                        borderRadius: '4px'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--light)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                    Sync Now
                </button>
            )}
        </div>
    );
}
