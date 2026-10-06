// src/pages/Subscription.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../firebase';
import { 
    collection, query, where, getDocs, doc, getDoc,
    orderBy, limit
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';

import { showAppNotice } from '../utils/appNotice';
export default function Subscription() {
    const navigate = useNavigate();
    const { currentUser, userData, userRole } = useAuth();
    
    // State for data
    const [schoolData, setSchoolData] = useState(null);
    const [invoices, setInvoices] = useState([]);
    const [loading, setLoading] = useState(true);
    
    // State for modal
    const [showInvoiceModal, setShowInvoiceModal] = useState(false);
    
    // Contact information
    const contactInfo = {
        email: 'info.edupriva@gmail.com',
        whatsapp: '+254114963959',
        whatsappUrl: 'https://wa.me/254114963959'
    };
    
    // Load data on mount
    useEffect(() => {
        if (currentUser && userData) {
            loadData();
        }
    }, [currentUser, userData]);

    // Load school data and invoices
    const loadData = async () => {
        setLoading(true);
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) {
                showNotification('School ID not found', 'error');
                setLoading(false);
                return;
            }

            // Load school data
            const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
            if (schoolDoc.exists()) {
                setSchoolData({
                    id: schoolDoc.id,
                    ...schoolDoc.data()
                });
            }

            // Load invoices
            const invoicesSnap = await getDocs(query(collection(db, 'invoices'), where('schoolId', '==', schoolId)));
            const invoicesList = invoicesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setInvoices(invoicesList);

        } catch (error) {
            console.error('Error loading data:', error);
            showNotification('Failed to load data', 'error');
        } finally {
            setLoading(false);
        }
    };

    // Open invoice modal
    const handleInvoiceHistory = () => {
        setShowInvoiceModal(true);
    };

    // Close invoice modal
    const closeInvoiceModal = () => {
        setShowInvoiceModal(false);
    };

    // Handle WhatsApp chat
    const handleWhatsAppChat = () => {
        const message = encodeURIComponent(
            'Hello, I would like to inquire about subscribing to TOPLINK EDU platform. Please assist me with the available plans and pricing.'
        );
        window.open(`${contactInfo.whatsappUrl}?text=${message}`, '_blank');
    };

    // Handle email support
    const handleEmailSupport = () => {
        window.location.href = `mailto:${contactInfo.email}?subject=Subscription Inquiry - TOPLINK EDU`;
    };

    // Show notification
    const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading subscription data..." />;
    }

    return (
        <Layout title="Subscription Support">
            <div style={{
                maxWidth: '900px',
                margin: '0 auto'
            }}>
                {/* Support Card */}
                <div className="support-card" style={{
                    background: 'white',
                    borderRadius: '16px',
                    padding: '40px',
                    boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                    marginBottom: '30px',
                    textAlign: 'center'
                }}>
                    <div className="support-icon" style={{
                        width: '100px',
                        height: '100px',
                        borderRadius: '50%',
                        background: '#1a237e',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        margin: '0 auto 25px',
                        fontSize: '48px',
                        color: 'white'
                    }}>
                        <i className="fas fa-headset"></i>
                    </div>
                    <h2 style={{
                        fontSize: '28px',
                        color: '#2c3e50',
                        marginBottom: '10px'
                    }}>Subscription & Support</h2>
                    <p className="subtitle" style={{
                        fontSize: '16px',
                        color: '#95a5a6',
                        marginBottom: '30px',
                        lineHeight: '1.6'
                    }}>
                        For all subscription inquiries, plan upgrades, and payment-related issues, 
                        please contact our <strong style={{color: '#1a237e'}}>Platform Administrator</strong> directly.
                    </p>

                    {/* Contact Methods */}
                    <div className="contact-methods" style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: '25px',
                        margin: '30px 0'
                    }}>
                        <div className="contact-method" style={{
                            background: '#f8f9fa',
                            borderRadius: '12px',
                            padding: '25px',
                            textAlign: 'center',
                            transition: 'all 0.3s',
                            border: '2px solid transparent',
                            cursor: 'pointer'
                        }}
                        onClick={handleEmailSupport}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = '#1a237e';
                            e.currentTarget.style.transform = 'translateY(-3px)';
                            e.currentTarget.style.boxShadow = '0 4px 6px rgba(0,0,0,0.07)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = 'transparent';
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.boxShadow = 'none';
                        }}
                        >
                            <div className="method-icon email" style={{
                                width: '60px',
                                height: '60px',
                                borderRadius: '50%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                margin: '0 auto 15px',
                                fontSize: '28px',
                                color: 'white',
                                background: '#4f46e5'
                            }}>
                                <i className="fas fa-envelope"></i>
                            </div>
                            <h3 style={{
                                fontSize: '16px',
                                color: '#2c3e50',
                                marginBottom: '5px'
                            }}>Email Support</h3>
                            <p style={{
                                fontSize: '14px',
                                color: '#95a5a6',
                                marginBottom: '12px'
                            }}>Send us an email for any subscription inquiries</p>
                            <div className="contact-value" style={{
                                fontSize: '16px',
                                fontWeight: '600',
                                color: '#2c3e50',
                                wordBreak: 'break-all'
                            }}>
                                <a href={`mailto:${contactInfo.email}`} style={{
                                    color: '#1a237e',
                                    textDecoration: 'none'
                                }}>{contactInfo.email}</a>
                            </div>
                        </div>

                        <div className="contact-method" style={{
                            background: '#f8f9fa',
                            borderRadius: '12px',
                            padding: '25px',
                            textAlign: 'center',
                            transition: 'all 0.3s',
                            border: '2px solid transparent',
                            cursor: 'pointer'
                        }}
                        onClick={handleWhatsAppChat}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = '#25D366';
                            e.currentTarget.style.transform = 'translateY(-3px)';
                            e.currentTarget.style.boxShadow = '0 4px 6px rgba(0,0,0,0.07)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = 'transparent';
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.boxShadow = 'none';
                        }}
                        >
                            <div className="method-icon whatsapp" style={{
                                width: '60px',
                                height: '60px',
                                borderRadius: '50%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                margin: '0 auto 15px',
                                fontSize: '28px',
                                color: 'white',
                                background: '#16a34a'
                            }}>
                                <i className="fab fa-whatsapp"></i>
                            </div>
                            <h3 style={{
                                fontSize: '16px',
                                color: '#2c3e50',
                                marginBottom: '5px'
                            }}>WhatsApp</h3>
                            <p style={{
                                fontSize: '14px',
                                color: '#95a5a6',
                                marginBottom: '12px'
                            }}>Chat with us instantly on WhatsApp</p>
                            <div className="contact-value" style={{
                                fontSize: '16px',
                                fontWeight: '600',
                                color: '#2c3e50',
                                wordBreak: 'break-all'
                            }}>
                                <a href={contactInfo.whatsappUrl} target="_blank" rel="noopener noreferrer" style={{
                                    color: '#1a237e',
                                    textDecoration: 'none'
                                }}>{contactInfo.whatsapp}</a>
                            </div>
                        </div>
                    </div>

                    {/* Info Box */}
                    <div className="info-box" style={{
                        background: '#e8f0fe',
                        borderRadius: '12px',
                        padding: '20px 25px',
                        margin: '25px 0',
                        borderLeft: '4px solid #1a237e',
                        textAlign: 'left'
                    }}>
                        <h4 style={{
                            fontSize: '15px',
                            color: '#1a237e',
                            marginBottom: '8px'
                        }}>
                            <i className="fas fa-info-circle"></i> How to Subscribe
                        </h4>
                        <p style={{
                            fontSize: '14px',
                            color: '#2c3e50',
                            lineHeight: '1.6'
                        }}>To subscribe or upgrade your plan, please follow these steps:</p>
                        <ul style={{
                            listStyle: 'none',
                            padding: 0,
                            margin: '10px 0 0'
                        }}>
                            <li style={{
                                padding: '5px 0',
                                fontSize: '14px',
                                color: '#2c3e50',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px'
                            }}>
                                <i className="fas fa-check-circle" style={{
                                    color: '#27ae60',
                                    width: '20px'
                                }}></i>
                                <span>Contact our platform administrator via email or WhatsApp</span>
                            </li>
                            <li style={{
                                padding: '5px 0',
                                fontSize: '14px',
                                color: '#2c3e50',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px'
                            }}>
                                <i className="fas fa-check-circle" style={{
                                    color: '#27ae60',
                                    width: '20px'
                                }}></i>
                                <span>Choose your preferred plan (Basic, Standard, or Premium)</span>
                            </li>
                            <li style={{
                                padding: '5px 0',
                                fontSize: '14px',
                                color: '#2c3e50',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px'
                            }}>
                                <i className="fas fa-check-circle" style={{
                                    color: '#27ae60',
                                    width: '20px'
                                }}></i>
                                <span>Complete the payment process</span>
                            </li>
                            <li style={{
                                padding: '5px 0',
                                fontSize: '14px',
                                color: '#2c3e50',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px'
                            }}>
                                <i className="fas fa-check-circle" style={{
                                    color: '#27ae60',
                                    width: '20px'
                                }}></i>
                                <span>Your plan will be activated within 24 hours</span>
                            </li>
                        </ul>
                    </div>

                    {/* WhatsApp Button */}
                    <div className="whatsapp-button-container" style={{marginTop: '20px'}}>
                        <button 
                            className="btn btn-whatsapp btn-lg"
                            style={{
                                padding: '14px 40px',
                                fontSize: '18px',
                                borderRadius: '50px',
                                border: 'none',
                                fontWeight: '600',
                                cursor: 'pointer',
                                transition: 'all 0.3s',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '8px',
                                background: '#25D366',
                                color: 'white'
                            }}
                            onClick={handleWhatsAppChat}
                        >
                            <i className="fab fa-whatsapp" style={{fontSize: '24px'}}></i> 
                            Chat on WhatsApp
                        </button>
                    </div>

                    <p style={{
                        marginTop: '20px',
                        fontSize: '13px',
                        color: '#95a5a6'
                    }}>
                        <i className="fas fa-clock"></i> Response time: Within 24 hours
                    </p>
                </div>
            </div>

            {/* Invoice History Modal */}
            {showInvoiceModal && (
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
                            }}>Invoice History</h2>
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
                                onClick={closeInvoiceModal}
                            >
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <div className="invoice-list" id="invoiceList">
                            {invoices.length === 0 ? (
                                <div style={{
                                    textAlign: 'center',
                                    padding: '30px',
                                    color: '#95a5a6'
                                }}>
                                    <i className="fas fa-file-invoice" style={{
                                        fontSize: '48px',
                                        display: 'block',
                                        marginBottom: '10px',
                                        color: '#e0e6ed'
                                    }}></i>
                                    <p>No invoices found</p>
                                </div>
                            ) : (
                                invoices.map((invoice, index) => (
                                    <div key={index} className="invoice-item" style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        padding: '15px 20px',
                                        background: 'white',
                                        borderRadius: '8px',
                                        boxShadow: '0 4px 6px rgba(0,0,0,0.07)',
                                        marginBottom: '10px',
                                        flexWrap: 'wrap',
                                        gap: '10px'
                                    }}>
                                        <div className="invoice-info" style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: '3px'
                                        }}>
                                            <div className="invoice-id" style={{
                                                fontWeight: '600',
                                                color: '#2c3e50'
                                            }}>{invoice.id}</div>
                                            <div className="invoice-date" style={{
                                                fontSize: '13px',
                                                color: '#95a5a6'
                                            }}>{invoice.date}</div>
                                        </div>
                                        <div className="invoice-amount" style={{
                                            fontSize: '18px',
                                            fontWeight: '700',
                                            color: '#2c3e50'
                                        }}>
                                            KSh {invoice.amount.toLocaleString()}
                                        </div>
                                        <span className={`invoice-status ${invoice.status}`} style={{
                                            padding: '4px 12px',
                                            borderRadius: '20px',
                                            fontSize: '12px',
                                            fontWeight: '600',
                                            background: invoice.status === 'paid' ? '#d4edda' : 
                                                      invoice.status === 'pending' ? '#fff3cd' : '#f8d7da',
                                            color: invoice.status === 'paid' ? '#155724' : 
                                                   invoice.status === 'pending' ? '#856404' : '#721c24'
                                        }}>
                                            {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                                        </span>
                                    </div>
                                ))
                            )}
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
                .support-card {
                    transition: all 0.3s;
                }
                .support-card:hover {
                    box-shadow: 0 15px 35px rgba(0,0,0,0.12);
                }
                .btn-whatsapp:hover {
                    background: #128C7E !important;
                    transform: translateY(-2px);
                    box-shadow: 0 5px 15px rgba(37, 211, 102, 0.3);
                }
                .modal-close:hover {
                    background: #e0e6ed;
                }
                @media (max-width: 768px) {
                    .contact-methods {
                        grid-template-columns: 1fr !important;
                    }
                    .whatsapp-button-container .btn-whatsapp {
                        padding: 12px 30px !important;
                        font-size: 16px !important;
                        width: 100%;
                        justify-content: center;
                    }
                    .support-card {
                        padding: 25px 20px !important;
                    }
                    .support-card .support-icon {
                        width: 80px !important;
                        height: 80px !important;
                        font-size: 36px !important;
                    }
                    .support-card h2 {
                        font-size: 22px !important;
                    }
                }
                @media (max-width: 480px) {
                    .support-card .support-icon {
                        width: 70px !important;
                        height: 70px !important;
                        font-size: 30px !important;
                    }
                    .support-card h2 {
                        font-size: 20px !important;
                    }
                    .contact-method {
                        padding: 20px !important;
                    }
                }
            `}</style>
        </Layout>
    );
}
