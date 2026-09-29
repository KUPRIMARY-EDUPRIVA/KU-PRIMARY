// src/pages/Exams.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../firebase';
import { 
    collection, query, where, getDocs, onSnapshot,
    doc, getDoc, addDoc, updateDoc, deleteDoc,
    orderBy, serverTimestamp, limit, startAfter
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import {
    LEVEL_DISPLAY_NAMES,
    LEVEL_BADGE_CLASSES
} from '../utils/constants';

export default function Exams() {
    const navigate = useNavigate();
    const { currentUser, userData, userRole } = useAuth();
    
    // State for data
    const [exams, setExams] = useState([]);
    const [filteredExams, setFilteredExams] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    
    // State for stats
    const [stats, setStats] = useState({
        total: 0,
        active: 0,
        upcoming: 0,
        completed: 0
    });
    
    // State for filters
    const [filters, setFilters] = useState({
        search: '',
        level: '',
        status: ''
    });
    
    // State for pagination
    const [currentPage, setCurrentPage] = useState(1);
    const [totalRecords, setTotalRecords] = useState(0);
    const pageSize = 10;
    
    // State for modal
    const [showModal, setShowModal] = useState(false);
    const [showViewModal, setShowViewModal] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [selectedExam, setSelectedExam] = useState(null);
    const [formData, setFormData] = useState({
        id: '',
        name: '',
        level: '',
        subject: '',
        competencies: '',
        startDate: '',
        endDate: '',
        duration: '',
        status: 'upcoming',
        maxScore: 100,
        description: '',
        instructions: ''
    });
    
    // Refs
    const searchTimeoutRef = useRef(null);
    
    // Load exams on mount
    useEffect(() => {
        if (currentUser && userData) {
            loadExams();
        }
    }, [currentUser, userData]);

    // Load exams from Firestore
    const loadExams = async () => {
        setLoading(true);
        try {
            const schoolId = userData?.schoolId || 'default_school';
            
            const examsQuery = query(
                collection(db, 'exams'),
                where('schoolId', '==', schoolId),
                orderBy('createdAt', 'desc')
            );
            const snapshot = await getDocs(examsQuery);
            
            const examsData = [];
            snapshot.forEach(doc => {
                examsData.push({
                    id: doc.id,
                    ...doc.data()
                });
            });
            
            setExams(examsData);
            updateStats(examsData);
            applyFilters(examsData);
            
        } catch (error) {
            console.error('Error loading exams:', error);
            showNotification('Failed to load exams', 'error');
        } finally {
            setLoading(false);
        }
    };

    // Update stats
    const updateStats = (examsData) => {
        const total = examsData.length;
        const active = examsData.filter(e => e.status === 'active').length;
        const upcoming = examsData.filter(e => e.status === 'upcoming').length;
        const completed = examsData.filter(e => e.status === 'completed').length;
        
        setStats({ total, active, upcoming, completed });
    };

    // Apply filters
    const applyFilters = (examsData = exams) => {
        const { search, level, status } = filters;
        
        const filtered = examsData.filter(exam => {
            const matchSearch = !search || 
                exam.name?.toLowerCase().includes(search.toLowerCase()) ||
                exam.subject?.toLowerCase().includes(search.toLowerCase()) ||
                exam.competencies?.toLowerCase().includes(search.toLowerCase());
            const matchLevel = !level || exam.level === level;
            const matchStatus = !status || exam.status === status;
            return matchSearch && matchLevel && matchStatus;
        });
        
        setFilteredExams(filtered);
        setTotalRecords(filtered.length);
        setCurrentPage(1);
    };

    // Handle filter changes
    const handleFilterChange = (e) => {
        const { id, value } = e.target;
        const filterKey = id === 'searchInput' ? 'search' : 
                         id === 'levelFilter' ? 'level' : 
                         id === 'statusFilter' ? 'status' : '';
        
        setFilters(prev => ({
            ...prev,
            [filterKey]: value
        }));
    };

    // Apply filters on button click
    const handleApplyFilters = () => {
        applyFilters();
    };

    // Clear filters
    const handleClearFilters = () => {
        setFilters({
            search: '',
            level: '',
            status: ''
        });
        document.getElementById('searchInput').value = '';
        document.getElementById('levelFilter').value = '';
        document.getElementById('statusFilter').value = '';
        setFilteredExams(exams);
        setCurrentPage(1);
    };

    // Handle form input changes
    const handleFormChange = (e) => {
        const { id, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [id.replace('exam', '').toLowerCase()]: value
        }));
    };

    // Open create exam modal
    const handleAddExam = () => {
        setIsEditing(false);
        setFormData({
            id: '',
            name: '',
            level: '',
            subject: '',
            competencies: '',
            startDate: new Date().toISOString().slice(0, 16),
            endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
            duration: '',
            status: 'upcoming',
            maxScore: 100,
            description: '',
            instructions: ''
        });
        setShowModal(true);
    };

    // View exam details
    const viewExam = (id) => {
        const exam = exams.find(e => e.id === id);
        if (exam) {
            setSelectedExam(exam);
            setShowViewModal(true);
        }
    };

    // Edit exam
    const editExam = (id) => {
        const exam = exams.find(e => e.id === id);
        if (!exam) return;
        
        setIsEditing(true);
        const start = exam.startDate?.toDate?.() || new Date(exam.startDate);
        const end = exam.endDate?.toDate?.() || new Date(exam.endDate);
        
        setFormData({
            id: exam.id,
            name: exam.name || '',
            level: exam.level || '',
            subject: exam.subject || '',
            competencies: exam.competencies || '',
            startDate: start ? start.toISOString().slice(0, 16) : '',
            endDate: end ? end.toISOString().slice(0, 16) : '',
            duration: exam.duration || '',
            status: exam.status || 'upcoming',
            maxScore: exam.maxScore || 100,
            description: exam.description || '',
            instructions: exam.instructions || ''
        });
        setShowModal(true);
    };

    // Delete exam
    const deleteExam = async (id) => {
        if (!window.confirm('Are you sure you want to delete this exam? This will also delete all associated results.')) return;
        
        try {
            await deleteDoc(doc(db, 'exams', id));
            showNotification('Exam deleted successfully', 'success');
            await loadExams();
        } catch (error) {
            console.error('Delete error:', error);
            showNotification('Failed to delete exam', 'error');
        }
    };

    // Manage results
    const manageResults = (id) => {
        navigate(`/results?examId=${id}`);
    };

    // Save exam (create or update)
    const saveExam = async (e) => {
        e.preventDefault();
        setSaving(true);
        
        const schoolId = userData?.schoolId || 'default_school';
        
        const data = {
            name: formData.name.trim(),
            level: formData.level,
            subject: formData.subject.trim(),
            competencies: formData.competencies.trim(),
            startDate: new Date(formData.startDate),
            endDate: new Date(formData.endDate),
            duration: parseInt(formData.duration) || null,
            status: formData.status,
            maxScore: parseInt(formData.maxScore) || 100,
            description: formData.description.trim(),
            instructions: formData.instructions.trim(),
            schoolId: schoolId,
            updatedAt: serverTimestamp()
        };

        // Validate dates
        if (data.startDate >= data.endDate) {
            showNotification('End date must be after start date', 'error');
            setSaving(false);
            return;
        }

        try {
            if (isEditing) {
                await updateDoc(doc(db, 'exams', formData.id), data);
                showNotification('Exam updated successfully', 'success');
            } else {
                data.createdAt = serverTimestamp();
                data.examId = `EXM${Date.now().toString().slice(-6)}`;
                await addDoc(collection(db, 'exams'), data);
                showNotification('Exam created successfully', 'success');
            }
            
            setShowModal(false);
            await loadExams();
        } catch (error) {
            console.error('Save error:', error);
            showNotification('Failed to save exam', 'error');
        } finally {
            setSaving(false);
        }
    };

    // Export exams to CSV
    const exportExams = () => {
        if (filteredExams.length === 0) {
            showNotification('No exams to export', 'warning');
            return;
        }
        
        const headers = ['ID', 'Name', 'Level', 'Subject', 'Competencies', 'Start Date', 'End Date', 'Status', 'Max Score'];
        const rows = filteredExams.map(e => {
            const start = e.startDate?.toDate?.() || new Date(e.startDate);
            const end = e.endDate?.toDate?.() || new Date(e.endDate);
            return [
                e.examId || '',
                e.name || '',
                LEVEL_DISPLAY_NAMES[e.level] || e.level || '',
                e.subject || '',
                e.competencies || '',
                start ? start.toLocaleString() : '',
                end ? end.toLocaleString() : '',
                e.status || '',
                e.maxScore || 100
            ];
        });
        
        const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
        downloadCSV(csv, `exams_${new Date().toISOString().slice(0,10)}.csv`);
        showNotification('Exams exported successfully', 'success');
    };

    // Download CSV
    const downloadCSV = (content, filename) => {
        const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    };

    // Render table
    const renderTable = () => {
        const start = (currentPage - 1) * pageSize;
        const end = start + pageSize;
        const pageExams = filteredExams.slice(start, end);

        if (pageExams.length === 0) {
            return (
                <tr>
                    <td colSpan="7">
                        <div style={{
                            textAlign: 'center',
                            padding: '60px 20px'
                        }}>
                            <i className="fas fa-file-alt" style={{
                                fontSize: '64px',
                                color: '#e0e6ed',
                                marginBottom: '20px'
                            }}></i>
                            <h3 style={{
                                fontSize: '20px',
                                color: '#2c3e50',
                                marginBottom: '10px'
                            }}>No Exams Found</h3>
                            <p style={{
                                color: '#95a5a6',
                                maxWidth: '400px',
                                margin: '0 auto 20px'
                            }}>
                                Create your first exam to assess student competencies.
                            </p>
                            <button 
                                className="btn btn-primary"
                                style={{
                                    padding: '10px 20px',
                                    border: 'none',
                                    borderRadius: '8px',
                                    fontWeight: '600',
                                    cursor: 'pointer',
                                    transition: 'all 0.3s',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    fontSize: '14px',
                                    background: '#3498db',
                                    color: 'white'
                                }}
                                onClick={handleAddExam}
                            >
                                <i className="fas fa-plus"></i> Create Exam
                            </button>
                        </div>
                    </td>
                </tr>
            );
        }

        const levelColors = {
            'pre-primary': '#ffeaa7',
            'lower-primary': '#74b9ff',
            'upper-primary': '#a29bfe',
            'junior-school': '#fd79a8',
            'senior-school': '#00b894'
        };

        return pageExams.map(exam => {
            const start = exam.startDate?.toDate?.() || new Date(exam.startDate);
            const end = exam.endDate?.toDate?.() || new Date(exam.endDate);
            const now = new Date();
            
            // Calculate progress
            let progress = 0;
            if (start && end) {
                const total = end - start;
                const elapsed = now - start;
                progress = Math.min(100, Math.max(0, (elapsed / total) * 100));
            }

            const competencies = exam.competencies ? exam.competencies.split(',').map(c => c.trim()).filter(c => c) : [];

            return (
                <tr key={exam.id}>
                    <td>
                        <div>
                            <strong>{exam.name || 'Unnamed Exam'}</strong>
                            <div style={{
                                fontSize: '12px',
                                color: '#95a5a6'
                            }}>
                                <i className="far fa-calendar-alt"></i> {start ? start.toLocaleDateString() : 'N/A'}
                            </div>
                        </div>
                    </td>
                    <td>
                        <span style={{
                            display: 'inline-block',
                            padding: '3px 12px',
                            borderRadius: '12px',
                            fontSize: '12px',
                            fontWeight: '600',
                            background: levelColors[exam.level] || '#95a5a6',
                            color: ['pre-primary', 'lower-primary', 'upper-primary'].includes(exam.level) ? '#2d3436' : 'white'
                        }}>
                            {LEVEL_DISPLAY_NAMES[exam.level] || exam.level || 'N/A'}
                        </span>
                    </td>
                    <td>{exam.subject || 'N/A'}</td>
                    <td>
                        <div style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '4px'
                        }}>
                            {competencies.length > 0 ? competencies.map((c, i) => (
                                <span key={i} style={{
                                    display: 'inline-block',
                                    padding: '2px 10px',
                                    background: '#f8f9fa',
                                    borderRadius: '12px',
                                    fontSize: '11px',
                                    color: '#2c3e50',
                                    border: '1px solid #e0e6ed'
                                }}>
                                    {c}
                                </span>
                            )) : 'N/A'}
                        </div>
                    </td>
                    <td>
                        <span style={{
                            padding: '4px 12px',
                            borderRadius: '20px',
                            fontSize: '12px',
                            fontWeight: '600',
                            background: exam.status === 'upcoming' ? '#d1ecf1' : 
                                      exam.status === 'active' ? '#d4edda' : 
                                      exam.status === 'completed' ? '#e2e3e5' : '#f8d7da',
                            color: exam.status === 'upcoming' ? '#0c5460' : 
                                   exam.status === 'active' ? '#155724' : 
                                   exam.status === 'completed' ? '#383d41' : '#721c24'
                        }}>
                            {exam.status ? exam.status.charAt(0).toUpperCase() + exam.status.slice(1) : 'Upcoming'}
                        </span>
                    </td>
                    <td>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px'
                        }}>
                            <span style={{
                                fontSize: '12px',
                                minWidth: '35px'
                            }}>{Math.round(progress)}%</span>
                            <div style={{
                                flex: 1,
                                minWidth: '50px',
                                height: '6px',
                                background: '#e0e6ed',
                                borderRadius: '3px',
                                overflow: 'hidden'
                            }}>
                                <div style={{
                                    height: '100%',
                                    background: '#27ae60',
                                    borderRadius: '3px',
                                    transition: 'width 0.3s ease',
                                    width: `${progress}%`
                                }}></div>
                            </div>
                        </div>
                    </td>
                    <td>
                        <div style={{
                            display: 'flex',
                            gap: '8px',
                            flexWrap: 'wrap'
                        }}>
                            <button 
                                className="action-btn view"
                                style={{
                                    padding: '6px 12px',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontSize: '13px',
                                    transition: 'all 0.3s',
                                    background: '#3498db',
                                    color: 'white'
                                }}
                                onClick={() => viewExam(exam.id)}
                            >
                                <i className="fas fa-eye"></i>
                            </button>
                            <button 
                                className="action-btn edit"
                                style={{
                                    padding: '6px 12px',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontSize: '13px',
                                    transition: 'all 0.3s',
                                    background: '#f39c12',
                                    color: 'white'
                                }}
                                onClick={() => editExam(exam.id)}
                            >
                                <i className="fas fa-edit"></i>
                            </button>
                            <button 
                                className="action-btn results"
                                style={{
                                    padding: '6px 12px',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontSize: '13px',
                                    transition: 'all 0.3s',
                                    background: '#27ae60',
                                    color: 'white'
                                }}
                                onClick={() => manageResults(exam.id)}
                            >
                                <i className="fas fa-chart-line"></i>
                            </button>
                            <button 
                                className="action-btn delete"
                                style={{
                                    padding: '6px 12px',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontSize: '13px',
                                    transition: 'all 0.3s',
                                    background: '#e74c3c',
                                    color: 'white'
                                }}
                                onClick={() => deleteExam(exam.id)}
                            >
                                <i className="fas fa-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            );
        });
    };

    // Render pagination
    const renderPagination = () => {
        const total = filteredExams.length;
        const totalPages = Math.ceil(total / pageSize);
        const start = (currentPage - 1) * pageSize + 1;
        const end = Math.min(currentPage * pageSize, total);

        if (total === 0) {
            return (
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '15px 20px',
                    background: 'white',
                    borderTop: '1px solid #e0e6ed'
                }}>
                    <div style={{
                        fontSize: '14px',
                        color: '#95a5a6'
                    }}>Showing 0 of 0 exams</div>
                </div>
            );
        }

        return (
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '15px 20px',
                background: 'white',
                borderTop: '1px solid #e0e6ed'
            }}>
                <div style={{
                    fontSize: '14px',
                    color: '#95a5a6'
                }}>
                    Showing {start}-{end} of {total} exams
                </div>
                <div style={{
                    display: 'flex',
                    gap: '5px'
                }}>
                    <button 
                        style={{
                            padding: '8px 14px',
                            border: '1px solid #e0e6ed',
                            borderRadius: '6px',
                            background: 'white',
                            cursor: currentPage > 1 ? 'pointer' : 'not-allowed',
                            transition: 'all 0.3s',
                            fontWeight: '500',
                            opacity: currentPage > 1 ? 1 : 0.5
                        }}
                        onClick={() => currentPage > 1 && setCurrentPage(currentPage - 1)}
                        disabled={currentPage === 1}
                    >
                        <i className="fas fa-chevron-left"></i>
                    </button>
                    
                    {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                        let pageNum;
                        if (totalPages <= 5) {
                            pageNum = i + 1;
                        } else if (currentPage <= 3) {
                            pageNum = i + 1;
                        } else if (currentPage >= totalPages - 2) {
                            pageNum = totalPages - 4 + i;
                        } else {
                            pageNum = currentPage - 2 + i;
                        }
                        
                        if (pageNum <= 0 || pageNum > totalPages) return null;
                        
                        return (
                            <button 
                                key={pageNum}
                                style={{
                                    padding: '8px 14px',
                                    border: '1px solid #e0e6ed',
                                    borderRadius: '6px',
                                    background: pageNum === currentPage ? '#3498db' : 'white',
                                    color: pageNum === currentPage ? 'white' : '#2c3e50',
                                    cursor: 'pointer',
                                    transition: 'all 0.3s',
                                    fontWeight: '500'
                                }}
                                onClick={() => setCurrentPage(pageNum)}
                            >
                                {pageNum}
                            </button>
                        );
                    })}
                    
                    <button 
                        style={{
                            padding: '8px 14px',
                            border: '1px solid #e0e6ed',
                            borderRadius: '6px',
                            background: 'white',
                            cursor: currentPage < totalPages ? 'pointer' : 'not-allowed',
                            transition: 'all 0.3s',
                            fontWeight: '500',
                            opacity: currentPage < totalPages ? 1 : 0.5
                        }}
                        onClick={() => currentPage < totalPages && setCurrentPage(currentPage + 1)}
                        disabled={currentPage === totalPages}
                    >
                        <i className="fas fa-chevron-right"></i>
                    </button>
                </div>
            </div>
        );
    };

    // Show notification
    const showNotification = (message, type = 'info') => {
        const colors = {
            success: '#27ae60',
            error: '#e74c3c',
            warning: '#f39c12',
            info: '#3498db'
        };

        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${colors[type] || colors.info};
            color: white;
            padding: 15px 20px;
            border-radius: 8px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
            z-index: 10000;
            animation: slideIn 0.3s ease;
            max-width: 400px;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading exams..." />;
    }

    return (
        <Layout title="Exams (CBC/CBE)">
            {/* Stats Grid */}
            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-label">Total Exams</div>
                    <div className="stat-value">{stats.total}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Active</div>
                    <div className="stat-value">{stats.active}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Upcoming</div>
                    <div className="stat-value">{stats.upcoming}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Completed</div>
                    <div className="stat-value">{stats.completed}</div>
                </div>
            </div>

            {/* Filters */}
            <div className="filters-section" style={{
                background: 'white',
                borderRadius: '12px',
                padding: '20px',
                boxShadow: '0 4px 6px rgba(0,0,0,0.07)',
                marginBottom: '25px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '15px',
                alignItems: 'center'
            }}>
                <input 
                    type="text" 
                    className="search-input" 
                    id="searchInput" 
                    placeholder="Search by name, subject, or competency..."
                    value={filters.search}
                    onChange={handleFilterChange}
                    onKeyPress={(e) => e.key === 'Enter' && handleApplyFilters()}
                    style={{
                        flex: 1,
                        minWidth: '200px',
                        padding: '10px 15px',
                        border: '2px solid #e0e6ed',
                        borderRadius: '8px',
                        fontSize: '14px',
                        transition: 'all 0.3s'
                    }}
                />
                <select 
                    className="filter-select" 
                    id="levelFilter"
                    value={filters.level}
                    onChange={handleFilterChange}
                    style={{
                        padding: '10px 15px',
                        border: '2px solid #e0e6ed',
                        borderRadius: '8px',
                        fontSize: '14px',
                        background: 'white',
                        cursor: 'pointer',
                        minWidth: '150px'
                    }}
                >
                    <option value="">All Levels</option>
                    <option value="pre-primary">Pre-Primary</option>
                    <option value="lower-primary">Lower Primary</option>
                    <option value="upper-primary">Upper Primary</option>
                    <option value="junior-school">Junior School</option>
                    <option value="senior-school">Senior School</option>
                </select>
                <select 
                    className="filter-select" 
                    id="statusFilter"
                    value={filters.status}
                    onChange={handleFilterChange}
                    style={{
                        padding: '10px 15px',
                        border: '2px solid #e0e6ed',
                        borderRadius: '8px',
                        fontSize: '14px',
                        background: 'white',
                        cursor: 'pointer',
                        minWidth: '150px'
                    }}
                >
                    <option value="">All Status</option>
                    <option value="upcoming">Upcoming</option>
                    <option value="active">Active</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                </select>
                <button 
                    className="btn btn-primary"
                    style={{
                        padding: '10px 20px',
                        border: 'none',
                        borderRadius: '8px',
                        fontWeight: '600',
                        cursor: 'pointer',
                        transition: 'all 0.3s',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        background: '#3498db',
                        color: 'white'
                    }}
                    onClick={handleApplyFilters}
                >
                    <i className="fas fa-filter"></i> Apply Filters
                </button>
                <button 
                    className="btn btn-outline"
                    style={{
                        padding: '10px 20px',
                        border: '2px solid #e0e6ed',
                        borderRadius: '8px',
                        fontWeight: '600',
                        cursor: 'pointer',
                        transition: 'all 0.3s',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        background: 'transparent',
                        color: '#2c3e50'
                    }}
                    onClick={handleClearFilters}
                >
                    <i className="fas fa-times"></i> Clear
                </button>
            </div>

            {/* Action Buttons */}
            <div style={{
                display: 'flex',
                gap: '10px',
                marginBottom: '20px',
                flexWrap: 'wrap'
            }}>
                <button 
                    className="btn btn-primary"
                    style={{
                        padding: '10px 20px',
                        border: 'none',
                        borderRadius: '8px',
                        fontWeight: '600',
                        cursor: 'pointer',
                        transition: 'all 0.3s',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        background: '#3498db',
                        color: 'white'
                    }}
                    onClick={handleAddExam}
                >
                    <i className="fas fa-plus"></i> Create Exam
                </button>
                <button 
                    className="btn btn-outline"
                    style={{
                        padding: '10px 20px',
                        border: '2px solid #e0e6ed',
                        borderRadius: '8px',
                        fontWeight: '600',
                        cursor: 'pointer',
                        transition: 'all 0.3s',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        background: 'transparent',
                        color: '#2c3e50'
                    }}
                    onClick={exportExams}
                >
                    <i className="fas fa-download"></i> Export
                </button>
            </div>

            {/* Table */}
            <div className="table-container" style={{
                background: 'white',
                borderRadius: '12px',
                boxShadow: '0 4px 6px rgba(0,0,0,0.07)',
                overflow: 'hidden'
            }}>
                <div className="table-wrapper" style={{overflowX: 'auto'}}>
                    <table style={{
                        width: '100%',
                        borderCollapse: 'collapse'
                    }}>
                        <thead>
                            <tr style={{
                                background: '#f8f9fa'
                            }}>
                                <th style={{
                                    padding: '15px 20px',
                                    textAlign: 'left',
                                    fontSize: '13px',
                                    fontWeight: '600',
                                    color: '#95a5a6',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px'
                                }}>Exam</th>
                                <th style={{
                                    padding: '15px 20px',
                                    textAlign: 'left',
                                    fontSize: '13px',
                                    fontWeight: '600',
                                    color: '#95a5a6',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px'
                                }}>Level</th>
                                <th style={{
                                    padding: '15px 20px',
                                    textAlign: 'left',
                                    fontSize: '13px',
                                    fontWeight: '600',
                                    color: '#95a5a6',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px'
                                }}>Subject/Area</th>
                                <th style={{
                                    padding: '15px 20px',
                                    textAlign: 'left',
                                    fontSize: '13px',
                                    fontWeight: '600',
                                    color: '#95a5a6',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px'
                                }}>Competencies</th>
                                <th style={{
                                    padding: '15px 20px',
                                    textAlign: 'left',
                                    fontSize: '13px',
                                    fontWeight: '600',
                                    color: '#95a5a6',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px'
                                }}>Status</th>
                                <th style={{
                                    padding: '15px 20px',
                                    textAlign: 'left',
                                    fontSize: '13px',
                                    fontWeight: '600',
                                    color: '#95a5a6',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px'
                                }}>Progress</th>
                                <th style={{
                                    padding: '15px 20px',
                                    textAlign: 'left',
                                    fontSize: '13px',
                                    fontWeight: '600',
                                    color: '#95a5a6',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px'
                                }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {renderTable()}
                        </tbody>
                    </table>
                </div>
                {renderPagination()}
            </div>

            {/* Add/Edit Exam Modal */}
            {showModal && (
                <div className="modal-overlay active" style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0,0,0,0.5)',
                    zIndex: 1000,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '20px'
                }}>
                    <div className="modal" style={{
                        background: 'white',
                        borderRadius: '16px',
                        maxWidth: '700px',
                        width: '100%',
                        maxHeight: '90vh',
                        overflowY: 'auto',
                        padding: '30px'
                    }}>
                        <div className="modal-header" style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: '25px'
                        }}>
                            <h2 style={{
                                fontSize: '22px',
                                color: '#2c3e50'
                            }}>{isEditing ? 'Edit Exam' : 'Create Exam'}</h2>
                            <button 
                                className="modal-close"
                                style={{
                                    width: '40px',
                                    height: '40px',
                                    border: 'none',
                                    borderRadius: '50%',
                                    background: '#f8f9fa',
                                    cursor: 'pointer',
                                    fontSize: '18px',
                                    transition: 'all 0.3s'
                                }}
                                onClick={() => setShowModal(false)}
                            >
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <form onSubmit={saveExam}>
                            <input type="hidden" id="examId" value={formData.id} />
                            
                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>
                                    Exam Name <span style={{color: '#e74c3c'}}>*</span>
                                </label>
                                <input 
                                    type="text" 
                                    id="examName" 
                                    value={formData.name}
                                    onChange={handleFormChange}
                                    placeholder="e.g. End of Term Assessment"
                                    required
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s'
                                    }}
                                />
                            </div>

                            <div className="form-row" style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: '15px'
                            }}>
                                <div className="form-group" style={{marginBottom: '20px'}}>
                                    <label style={{
                                        display: 'block',
                                        fontSize: '14px',
                                        fontWeight: '600',
                                        color: '#2c3e50',
                                        marginBottom: '5px'
                                    }}>
                                        Curriculum Level <span style={{color: '#e74c3c'}}>*</span>
                                    </label>
                                    <select 
                                        id="examLevel" 
                                        value={formData.level}
                                        onChange={handleFormChange}
                                        required
                                        style={{
                                            width: '100%',
                                            padding: '10px 15px',
                                            border: '2px solid #e0e6ed',
                                            borderRadius: '8px',
                                            fontSize: '14px',
                                            transition: 'all 0.3s',
                                            background: 'white'
                                        }}
                                    >
                                        <option value="">Select Level</option>
                                        <option value="pre-primary">Pre-Primary</option>
                                        <option value="lower-primary">Lower Primary (Grade 1-3)</option>
                                        <option value="upper-primary">Upper Primary (Grade 4-6)</option>
                                        <option value="junior-school">Junior School (Grade 7-9)</option>
                                        <option value="senior-school">Senior School (Grade 10-12)</option>
                                    </select>
                                </div>
                                <div className="form-group" style={{marginBottom: '20px'}}>
                                    <label style={{
                                        display: 'block',
                                        fontSize: '14px',
                                        fontWeight: '600',
                                        color: '#2c3e50',
                                        marginBottom: '5px'
                                    }}>
                                        Learning Area / Subject <span style={{color: '#e74c3c'}}>*</span>
                                    </label>
                                    <input 
                                        type="text" 
                                        id="examSubject" 
                                        value={formData.subject}
                                        onChange={handleFormChange}
                                        placeholder="e.g. Mathematics, Language, Science"
                                        required
                                        style={{
                                            width: '100%',
                                            padding: '10px 15px',
                                            border: '2px solid #e0e6ed',
                                            borderRadius: '8px',
                                            fontSize: '14px',
                                            transition: 'all 0.3s'
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>Competencies Assessed</label>
                                <input 
                                    type="text" 
                                    id="examCompetencies" 
                                    value={formData.competencies}
                                    onChange={handleFormChange}
                                    placeholder="e.g. Critical Thinking, Problem Solving, Communication"
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s'
                                    }}
                                />
                                <small style={{
                                    color: '#95a5a6',
                                    fontSize: '12px'
                                }}>Separate with commas</small>
                            </div>

                            <div className="form-row-3" style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr 1fr',
                                gap: '15px'
                            }}>
                                <div className="form-group" style={{marginBottom: '20px'}}>
                                    <label style={{
                                        display: 'block',
                                        fontSize: '14px',
                                        fontWeight: '600',
                                        color: '#2c3e50',
                                        marginBottom: '5px'
                                    }}>
                                        Start Date <span style={{color: '#e74c3c'}}>*</span>
                                    </label>
                                    <input 
                                        type="datetime-local" 
                                        id="examStartDate" 
                                        value={formData.startDate}
                                        onChange={handleFormChange}
                                        required
                                        style={{
                                            width: '100%',
                                            padding: '10px 15px',
                                            border: '2px solid #e0e6ed',
                                            borderRadius: '8px',
                                            fontSize: '14px',
                                            transition: 'all 0.3s'
                                        }}
                                    />
                                </div>
                                <div className="form-group" style={{marginBottom: '20px'}}>
                                    <label style={{
                                        display: 'block',
                                        fontSize: '14px',
                                        fontWeight: '600',
                                        color: '#2c3e50',
                                        marginBottom: '5px'
                                    }}>
                                        End Date <span style={{color: '#e74c3c'}}>*</span>
                                    </label>
                                    <input 
                                        type="datetime-local" 
                                        id="examEndDate" 
                                        value={formData.endDate}
                                        onChange={handleFormChange}
                                        required
                                        style={{
                                            width: '100%',
                                            padding: '10px 15px',
                                            border: '2px solid #e0e6ed',
                                            borderRadius: '8px',
                                            fontSize: '14px',
                                            transition: 'all 0.3s'
                                        }}
                                    />
                                </div>
                                <div className="form-group" style={{marginBottom: '20px'}}>
                                    <label style={{
                                        display: 'block',
                                        fontSize: '14px',
                                        fontWeight: '600',
                                        color: '#2c3e50',
                                        marginBottom: '5px'
                                    }}>Duration (minutes)</label>
                                    <input 
                                        type="number" 
                                        id="examDuration" 
                                        value={formData.duration}
                                        onChange={handleFormChange}
                                        placeholder="e.g. 60"
                                        min="1"
                                        style={{
                                            width: '100%',
                                            padding: '10px 15px',
                                            border: '2px solid #e0e6ed',
                                            borderRadius: '8px',
                                            fontSize: '14px',
                                            transition: 'all 0.3s'
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="form-row" style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: '15px'
                            }}>
                                <div className="form-group" style={{marginBottom: '20px'}}>
                                    <label style={{
                                        display: 'block',
                                        fontSize: '14px',
                                        fontWeight: '600',
                                        color: '#2c3e50',
                                        marginBottom: '5px'
                                    }}>Status</label>
                                    <select 
                                        id="examStatus" 
                                        value={formData.status}
                                        onChange={handleFormChange}
                                        style={{
                                            width: '100%',
                                            padding: '10px 15px',
                                            border: '2px solid #e0e6ed',
                                            borderRadius: '8px',
                                            fontSize: '14px',
                                            transition: 'all 0.3s',
                                            background: 'white'
                                        }}
                                    >
                                        <option value="upcoming">Upcoming</option>
                                        <option value="active">Active</option>
                                        <option value="completed">Completed</option>
                                        <option value="cancelled">Cancelled</option>
                                    </select>
                                </div>
                                <div className="form-group" style={{marginBottom: '20px'}}>
                                    <label style={{
                                        display: 'block',
                                        fontSize: '14px',
                                        fontWeight: '600',
                                        color: '#2c3e50',
                                        marginBottom: '5px'
                                    }}>Max Score</label>
                                    <input 
                                        type="number" 
                                        id="examMaxScore" 
                                        value={formData.maxScore}
                                        onChange={handleFormChange}
                                        placeholder="e.g. 100"
                                        min="1"
                                        style={{
                                            width: '100%',
                                            padding: '10px 15px',
                                            border: '2px solid #e0e6ed',
                                            borderRadius: '8px',
                                            fontSize: '14px',
                                            transition: 'all 0.3s'
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>Description</label>
                                <textarea 
                                    id="examDescription" 
                                    rows="3" 
                                    value={formData.description}
                                    onChange={handleFormChange}
                                    placeholder="Brief description of the exam and what it assesses..."
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s',
                                        resize: 'vertical'
                                    }}
                                />
                            </div>

                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>Instructions for Students</label>
                                <textarea 
                                    id="examInstructions" 
                                    rows="3" 
                                    value={formData.instructions}
                                    onChange={handleFormChange}
                                    placeholder="Instructions for students taking this exam..."
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s',
                                        resize: 'vertical'
                                    }}
                                />
                            </div>

                            <div className="modal-footer" style={{
                                display: 'flex',
                                gap: '10px',
                                justifyContent: 'flex-end',
                                marginTop: '25px',
                                paddingTop: '20px',
                                borderTop: '1px solid #e0e6ed'
                            }}>
                                <button 
                                    type="button" 
                                    className="btn btn-outline"
                                    style={{
                                        padding: '10px 20px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontWeight: '600',
                                        cursor: 'pointer',
                                        transition: 'all 0.3s',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        fontSize: '14px',
                                        background: 'transparent',
                                        color: '#2c3e50'
                                    }}
                                    onClick={() => setShowModal(false)}
                                >
                                    Cancel
                                </button>
                                <button 
                                    type="submit" 
                                    className="btn btn-primary"
                                    style={{
                                        padding: '10px 20px',
                                        border: 'none',
                                        borderRadius: '8px',
                                        fontWeight: '600',
                                        cursor: 'pointer',
                                        transition: 'all 0.3s',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        fontSize: '14px',
                                        background: '#3498db',
                                        color: 'white'
                                    }}
                                    disabled={saving}
                                >
                                    <i className="fas fa-save"></i> {saving ? 'Saving...' : (isEditing ? 'Update Exam' : 'Create Exam')}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* View Exam Modal */}
            {showViewModal && selectedExam && (
                <div className="modal-overlay active" style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0,0,0,0.5)',
                    zIndex: 1000,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '20px'
                }}>
                    <div className="modal" style={{
                        background: 'white',
                        borderRadius: '16px',
                        maxWidth: '700px',
                        width: '100%',
                        maxHeight: '90vh',
                        overflowY: 'auto',
                        padding: '30px'
                    }}>
                        <div className="modal-header" style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: '25px'
                        }}>
                            <h2 style={{
                                fontSize: '22px',
                                color: '#2c3e50'
                            }}>{selectedExam.name || 'Exam Details'}</h2>
                            <button 
                                className="modal-close"
                                style={{
                                    width: '40px',
                                    height: '40px',
                                    border: 'none',
                                    borderRadius: '50%',
                                    background: '#f8f9fa',
                                    cursor: 'pointer',
                                    fontSize: '18px',
                                    transition: 'all 0.3s'
                                }}
                                onClick={() => setShowViewModal(false)}
                            >
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <div id="viewExamContent">
                            <div style={{
                                display: 'grid',
                                gap: '15px'
                            }}>
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 1fr',
                                    gap: '15px'
                                }}>
                                    <div>
                                        <label style={{
                                            fontWeight: '600',
                                            color: '#95a5a6',
                                            fontSize: '13px'
                                        }}>Level</label>
                                        <div>
                                            <span style={{
                                                display: 'inline-block',
                                                padding: '3px 12px',
                                                borderRadius: '12px',
                                                fontSize: '12px',
                                                fontWeight: '600',
                                                background: '#e0e6ed',
                                                color: '#2c3e50'
                                            }}>
                                                {LEVEL_DISPLAY_NAMES[selectedExam.level] || selectedExam.level || 'N/A'}
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <label style={{
                                            fontWeight: '600',
                                            color: '#95a5a6',
                                            fontSize: '13px'
                                        }}>Subject</label>
                                        <div><strong>{selectedExam.subject || 'N/A'}</strong></div>
                                    </div>
                                </div>

                                <div>
                                    <label style={{
                                        fontWeight: '600',
                                        color: '#95a5a6',
                                        fontSize: '13px'
                                    }}>Competencies Assessed</label>
                                    <div style={{
                                        display: 'flex',
                                        flexWrap: 'wrap',
                                        gap: '4px',
                                        marginTop: '5px'
                                    }}>
                                        {(() => {
                                            const competencies = selectedExam.competencies ? selectedExam.competencies.split(',').map(c => c.trim()).filter(c => c) : [];
                                            return competencies.length > 0 ? competencies.map((c, i) => (
                                                <span key={i} style={{
                                                    display: 'inline-block',
                                                    padding: '2px 10px',
                                                    background: '#f8f9fa',
                                                    borderRadius: '12px',
                                                    fontSize: '11px',
                                                    color: '#2c3e50',
                                                    border: '1px solid #e0e6ed'
                                                }}>
                                                    {c}
                                                </span>
                                            )) : 'None specified'
                                        })()}
                                    </div>
                                </div>

                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 1fr 1fr',
                                    gap: '15px'
                                }}>
                                    <div>
                                        <label style={{
                                            fontWeight: '600',
                                            color: '#95a5a6',
                                            fontSize: '13px'
                                        }}>Start Date</label>
                                        <div>{(selectedExam.startDate?.toDate?.() || new Date(selectedExam.startDate)).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <label style={{
                                            fontWeight: '600',
                                            color: '#95a5a6',
                                            fontSize: '13px'
                                        }}>End Date</label>
                                        <div>{(selectedExam.endDate?.toDate?.() || new Date(selectedExam.endDate)).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <label style={{
                                            fontWeight: '600',
                                            color: '#95a5a6',
                                            fontSize: '13px'
                                        }}>Duration</label>
                                        <div>{selectedExam.duration ? selectedExam.duration + ' minutes' : 'Not specified'}</div>
                                    </div>
                                </div>

                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 1fr',
                                    gap: '15px'
                                }}>
                                    <div>
                                        <label style={{
                                            fontWeight: '600',
                                            color: '#95a5a6',
                                            fontSize: '13px'
                                        }}>Status</label>
                                        <div>
                                            <span style={{
                                                padding: '4px 12px',
                                                borderRadius: '20px',
                                                fontSize: '12px',
                                                fontWeight: '600',
                                                background: selectedExam.status === 'upcoming' ? '#d1ecf1' : 
                                                          selectedExam.status === 'active' ? '#d4edda' : 
                                                          selectedExam.status === 'completed' ? '#e2e3e5' : '#f8d7da',
                                                color: selectedExam.status === 'upcoming' ? '#0c5460' : 
                                                       selectedExam.status === 'active' ? '#155724' : 
                                                       selectedExam.status === 'completed' ? '#383d41' : '#721c24'
                                            }}>
                                                {selectedExam.status ? selectedExam.status.charAt(0).toUpperCase() + selectedExam.status.slice(1) : 'Upcoming'}
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <label style={{
                                            fontWeight: '600',
                                            color: '#95a5a6',
                                            fontSize: '13px'
                                        }}>Max Score</label>
                                        <div><strong>{selectedExam.maxScore || 100}</strong></div>
                                    </div>
                                </div>

                                {selectedExam.description && (
                                    <div>
                                        <label style={{
                                            fontWeight: '600',
                                            color: '#95a5a6',
                                            fontSize: '13px'
                                        }}>Description</label>
                                        <div style={{
                                            marginTop: '5px',
                                            padding: '10px',
                                            background: '#f8f9fa',
                                            borderRadius: '8px'
                                        }}>{selectedExam.description}</div>
                                    </div>
                                )}

                                {selectedExam.instructions && (
                                    <div>
                                        <label style={{
                                            fontWeight: '600',
                                            color: '#95a5a6',
                                            fontSize: '13px'
                                        }}>Instructions</label>
                                        <div style={{
                                            marginTop: '5px',
                                            padding: '10px',
                                            background: '#f8f9fa',
                                            borderRadius: '8px'
                                        }}>{selectedExam.instructions}</div>
                                    </div>
                                )}

                                <div style={{
                                    display: 'flex',
                                    gap: '10px',
                                    marginTop: '10px'
                                }}>
                                    <button 
                                        className="btn btn-primary"
                                        style={{
                                            padding: '10px 20px',
                                            border: 'none',
                                            borderRadius: '8px',
                                            fontWeight: '600',
                                            cursor: 'pointer',
                                            transition: 'all 0.3s',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            fontSize: '14px',
                                            background: '#3498db',
                                            color: 'white'
                                        }}
                                        onClick={() => {
                                            setShowViewModal(false);
                                            editExam(selectedExam.id);
                                        }}
                                    >
                                        <i className="fas fa-edit"></i> Edit
                                    </button>
                                    <button 
                                        className="btn btn-success"
                                        style={{
                                            padding: '10px 20px',
                                            border: 'none',
                                            borderRadius: '8px',
                                            fontWeight: '600',
                                            cursor: 'pointer',
                                            transition: 'all 0.3s',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            fontSize: '14px',
                                            background: '#27ae60',
                                            color: 'white'
                                        }}
                                        onClick={() => {
                                            setShowViewModal(false);
                                            manageResults(selectedExam.id);
                                        }}
                                    >
                                        <i className="fas fa-chart-line"></i> View Results
                                    </button>
                                    <button 
                                        className="btn btn-outline"
                                        style={{
                                            padding: '10px 20px',
                                            border: '2px solid #e0e6ed',
                                            borderRadius: '8px',
                                            fontWeight: '600',
                                            cursor: 'pointer',
                                            transition: 'all 0.3s',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            fontSize: '14px',
                                            background: 'transparent',
                                            color: '#2c3e50'
                                        }}
                                        onClick={() => setShowViewModal(false)}
                                    >
                                        Close
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Add animation styles */}
            <style>{`
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
                .stat-card {
                    transition: all 0.3s;
                }
                .stat-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 25px rgba(0,0,0,0.1);
                }
                .btn-primary:hover {
                    background: #2980b9 !important;
                    transform: translateY(-2px);
                    box-shadow: 0 10px 25px rgba(0,0,0,0.1);
                }
                .btn-outline:hover {
                    border-color: #3498db;
                    color: #3498db;
                }
                .action-btn.view:hover {
                    opacity: 0.9;
                }
                .action-btn.edit:hover {
                    opacity: 0.9;
                }
                .action-btn.results:hover {
                    opacity: 0.9;
                }
                .action-btn.delete:hover {
                    opacity: 0.9;
                }
                .search-input:focus {
                    outline: none;
                    border-color: #3498db !important;
                }
                .filter-select:focus {
                    outline: none;
                    border-color: #3498db !important;
                }
                .modal-close:hover {
                    background: #e0e6ed;
                }
                input:focus, select:focus, textarea:focus {
                    outline: none;
                    border-color: #3498db !important;
                }
                @media (max-width: 768px) {
                    .stats-grid {
                        grid-template-columns: repeat(2, 1fr) !important;
                    }
                    .filters-section {
                        flex-direction: column;
                        align-items: stretch;
                    }
                    .filters-section .search-input,
                    .filters-section .filter-select {
                        width: 100% !important;
                    }
                    .form-row,
                    .form-row-3 {
                        grid-template-columns: 1fr !important;
                    }
                    .modal {
                        padding: 20px !important;
                    }
                }
                @media (max-width: 480px) {
                    .stats-grid {
                        grid-template-columns: 1fr !important;
                    }
                }
            `}</style>
        </Layout>
    );
}
