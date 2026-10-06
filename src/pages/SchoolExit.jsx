// src/pages/SchoolExit.jsx
import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import SchoolExitService from '../services/SchoolExitService';
import { collection,
  query,
  where,doc, getDoc,getDocs, onSnapshot } from 'firebase/firestore';
import { activeDb } from '../firebase';

import { showAppNotice } from '../utils/appNotice';
export default function SchoolExit() {
  const { currentUser, userData } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [exitData, setExitData] = useState(null);
  const [exitStatus, setExitStatus] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState(null);

  useEffect(() => {
    // Check if exit has been initiated
    checkExitStatus();
  }, []);

  const checkExitStatus = async () => {
    setLoading(true);
    try {
      const exitsQuery = query(
        collection(activeDb, 'school_exits'),
        where('schoolId', '==', userData.schoolId),
        where('status', 'in', ['pending', 'processing', 'ready', 'downloaded'])
      );
      const snapshot = await getDocs(exitsQuery);
      
      if (!snapshot.empty) {
        const exit = snapshot.docs[0];
        setExitData({ id: exit.id, ...exit.data() });
        
        // Listen for realtime updates
        const unsub = onSnapshot(doc(activeDb, 'school_exits', exit.id), (doc) => {
          if (doc.exists()) {
            setExitData({ id: doc.id, ...doc.data() });
          }
        });
        
        return () => unsub();
      }
    } catch (error) {
      console.error('Error checking exit status:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleInitiateExit = async () => {
    if (!window.confirm(
      '⚠️ WARNING: This will initiate the school exit process.\n\n' +
      'This will:\n' +
      '1. Generate a complete export of all school data (PDF)\n' +
      '2. Archive the data for 30 days\n' +
      '3. After 30 days, all data will be permanently deleted\n\n' +
      'Continue?'
    )) return;

    setProcessing(true);
    try {
      const exitId = await SchoolExitService.initiateExit(
        userData.schoolId,
        currentUser.uid
      );
      
      // Start processing the exit package
      const result = await SchoolExitService.processExitPackage(exitId);
      setDownloadUrl(result.url);
      
      showNotification('School exit package generated successfully!', 'success');
      
      // Navigate to download
      setTimeout(() => {
        window.open(result.url, '_blank');
      }, 2000);
      
    } catch (error) {
      console.error('Error initiating exit:', error);
      showNotification('Failed to initiate school exit: ' + error.message, 'error');
    } finally {
      setProcessing(false);
    }
  };

  const handleDownload = async () => {
    if (!exitData) return;
    
    try {
      const url = await SchoolExitService.downloadExportPackage(exitData.id);
      window.open(url, '_blank');
      setExitData(prev => ({
        ...prev,
        exportPackage: {
          ...prev.exportPackage,
          downloadCount: (prev.exportPackage?.downloadCount || 0) + 1
        }
      }));
    } catch (error) {
      console.error('Error downloading:', error);
      showNotification('Failed to download: ' + error.message, 'error');
    }
  };

  const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

  if (loading) {
    return <LoadingSpinner fullScreen text="Checking exit status..." />;
  }

  return (
    <Layout title="School Exit & Data Export">
      <style>{`
        .exit-container {
          max-width: 900px;
          margin: 0 auto;
        }

        .exit-card {
          background: white;
          border-radius: 16px;
          padding: 30px;
          box-shadow: var(--shadow);
          margin-bottom: 20px;
        }

        .exit-status {
          display: inline-block;
          padding: 6px 16px;
          border-radius: 20px;
          font-size: 13px;
          font-weight: 600;
        }

        .exit-status.pending {
          background: #fff3cd;
          color: #856404;
        }

        .exit-status.processing {
          background: #d1ecf1;
          color: #0c5460;
        }

        .exit-status.ready {
          background: #d4edda;
          color: #155724;
        }

        .exit-status.downloaded {
          background: #d4edda;
          color: #155724;
        }

        .exit-status.deleted {
          background: #f8d7da;
          color: #721c24;
        }

        .exit-timeline {
          position: relative;
          padding-left: 30px;
          margin: 20px 0;
        }

        .exit-timeline::before {
          content: '';
          position: absolute;
          left: 8px;
          top: 0;
          bottom: 0;
          width: 2px;
          background: var(--border);
        }

        .timeline-item {
          position: relative;
          padding: 10px 0 10px 20px;
          border-left: 2px solid var(--border);
        }

        .timeline-item::before {
          content: '';
          position: absolute;
          left: -6px;
          top: 14px;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--primary);
        }

        .timeline-item.completed::before {
          background: var(--success);
        }

        .timeline-item .time {
          font-size: 12px;
          color: var(--gray);
        }

        .timeline-item .action {
          font-weight: 600;
          color: var(--secondary);
        }

        .exit-warning {
          background: #fff3cd;
          border: 1px solid #ffc107;
          border-radius: 8px;
          padding: 15px 20px;
          margin: 20px 0;
        }

        .exit-warning h4 {
          color: #856404;
          margin: 0 0 8px 0;
        }

        .exit-warning p {
          color: #856404;
          margin: 0;
          font-size: 14px;
        }

        .retention-info {
          background: #e8f0fe;
          border-radius: 8px;
          padding: 15px 20px;
          border-left: 4px solid var(--primary);
        }

        .btn {
          padding: 12px 24px;
          border: none;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
        }

        .btn-primary {
          background: var(--primary);
          color: white;
        }

        .btn-primary:hover {
          background: var(--primary-dark);
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .btn-success {
          background: var(--success);
          color: white;
        }

        .btn-success:hover {
          opacity: 0.9;
          transform: translateY(-2px);
        }

        .btn-danger {
          background: var(--danger);
          color: white;
        }

        .btn-danger:hover {
          opacity: 0.9;
          transform: translateY(-2px);
        }

        .btn-outline {
          background: transparent;
          border: 2px solid var(--border);
          color: var(--secondary);
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none !important;
        }

        .data-summary-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 15px;
          margin: 20px 0;
        }

        .summary-item {
          background: var(--light);
          border-radius: 8px;
          padding: 15px;
          text-align: center;
        }

        .summary-item .number {
          font-size: 24px;
          font-weight: 700;
          color: var(--primary);
        }

        .summary-item .label {
          font-size: 12px;
          color: var(--gray);
          margin-top: 5px;
        }

        .download-section {
          text-align: center;
          padding: 20px;
          background: #f8f9fa;
          border-radius: 8px;
          margin: 20px 0;
        }

        .download-section .file-size {
          color: var(--gray);
          font-size: 13px;
        }

        @media (max-width: 768px) {
          .data-summary-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
      `}</style>

      <div className="exit-container">
        {/* Exit Status Card */}
        <div className="exit-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <h2 style={{ margin: 0 }}>
              <i className="fas fa-door-open"></i> School Exit & Data Export
            </h2>
            {exitData && (
              <span className={`exit-status ${exitData.status}`}>
                {exitData.status.charAt(0).toUpperCase() + exitData.status.slice(1)}
              </span>
            )}
          </div>

          <div style={{ marginTop: '15px', color: 'var(--gray)' }}>
            <p>This process will generate a complete export of all school data and initiate the 30-day data retention period before permanent deletion.</p>
          </div>
        </div>

        {/* Exit Status / Timeline */}
        {exitData && exitData.history && (
          <div className="exit-card">
            <h3><i className="fas fa-clock"></i> Exit Timeline</h3>
            <div className="exit-timeline">
              {exitData.history.map((item, index) => (
                <div key={index} className="timeline-item completed">
                  <div className="time">{new Date(item.timestamp).toLocaleString()}</div>
                  <div className="action">{item.note}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Data Summary */}
        {exitData && exitData.dataSummary && (
          <div className="exit-card">
            <h3><i className="fas fa-chart-bar"></i> Data Summary</h3>
            <div className="data-summary-grid">
              <div className="summary-item">
                <div className="number">{exitData.dataSummary.totalStudents || 0}</div>
                <div className="label">Students</div>
              </div>
              <div className="summary-item">
                <div className="number">{exitData.dataSummary.totalTeachers || 0}</div>
                <div className="label">Teachers</div>
              </div>
              <div className="summary-item">
                <div className="number">{exitData.dataSummary.totalExams || 0}</div>
                <div className="label">Exams</div>
              </div>
              <div className="summary-item">
                <div className="number">{exitData.dataSummary.totalScores || 0}</div>
                <div className="label">Scores</div>
              </div>
            </div>
          </div>
        )}

        {/* Retention Info */}
        {exitData && exitData.retentionEndDate && (
          <div className="exit-card">
            <div className="retention-info">
              <h4 style={{ margin: '0 0 8px 0', color: 'var(--primary)' }}>
                <i className="fas fa-clock"></i> Data Retention Period
              </h4>
              <p style={{ margin: 0 }}>
                Your data will be retained for 30 days from the exit date.
              </p>
              <p style={{ margin: '8px 0 0 0', fontWeight: '600' }}>
                Retention End Date: {new Date(exitData.retentionEndDate).toLocaleDateString()}
              </p>
              {exitData.status === 'deleted' && (
                <p style={{ margin: '8px 0 0 0', color: 'var(--danger)' }}>
                  Data has been permanently deleted on {new Date(exitData.deletionSchedule?.deletedAt).toLocaleDateString()}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Export Package Download */}
        {exitData && exitData.status === 'ready' && exitData.exportPackage && (
          <div className="exit-card">
            <div className="download-section">
              <i className="fas fa-file-pdf" style={{ fontSize: '48px', color: 'var(--danger)' }}></i>
              <h3 style={{ margin: '10px 0' }}>Export Package Ready</h3>
              <p className="file-size">
                Generated: {new Date(exitData.exportPackage.generatedAt).toLocaleString()}
                {exitData.exportPackage.downloadCount > 0 && (
                  <span style={{ marginLeft: '10px' }}>
                    • Downloaded {exitData.exportPackage.downloadCount} time{exitData.exportPackage.downloadCount > 1 ? 's' : ''}
                  </span>
                )}
              </p>
              <button 
                className="btn btn-success"
                onClick={handleDownload}
                style={{ fontSize: '16px', padding: '14px 30px' }}
              >
                <i className="fas fa-download"></i> Download Export Package
              </button>
            </div>
          </div>
        )}

        {/* Warning & Action Buttons */}
        {!exitData && (
          <div className="exit-card">
            <div className="exit-warning">
              <h4><i className="fas fa-exclamation-triangle"></i> Important Notice</h4>
              <p>
                Once you initiate the school exit process:
              </p>
              <ul style={{ margin: '10px 0', paddingLeft: '20px' }}>
                <li>A complete data export will be generated (PDF)</li>
                <li>Data will be retained for 30 days</li>
                <li>After 30 days, all data will be permanently deleted</li>
                <li>This action cannot be undone</li>
              </ul>
            </div>

            <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', marginTop: '20px' }}>
              <button 
                className="btn btn-danger"
                onClick={handleInitiateExit}
                disabled={processing}
                style={{ fontSize: '16px', padding: '14px 30px' }}
              >
                {processing ? (
                  <>
                    <i className="fas fa-spinner fa-spin"></i> Processing...
                  </>
                ) : (
                  <>
                    <i className="fas fa-door-open"></i> Initiate School Exit
                  </>
                )}
              </button>
              <button 
                className="btn btn-outline"
                onClick={() => navigate('/dashboard')}
              >
                <i className="fas fa-arrow-left"></i> Cancel
              </button>
            </div>
          </div>
        )}

        {/* Confirmation when exit is already initiated */}
        {exitData && exitData.status !== 'deleted' && (
          <div className="exit-card">
            <div style={{ padding: '15px', background: '#e8f0fe', borderRadius: '8px' }}>
              <p style={{ margin: 0, color: 'var(--secondary)' }}>
                <i className="fas fa-info-circle"></i> 
                {exitData.status === 'pending' && ' Your exit request is being processed. You will be notified when the export package is ready.'}
                {exitData.status === 'processing' && ' Your data export is being generated. This may take a few minutes.'}
                {exitData.status === 'ready' && ' Your export package is ready for download above.'}
                {exitData.status === 'downloaded' && ' Your export package has been downloaded. Remember to save it securely.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
