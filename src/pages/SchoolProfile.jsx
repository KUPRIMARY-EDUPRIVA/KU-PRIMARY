// src/pages/SchoolProfile.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { LEVEL_CLASSES, LEVEL_DISPLAY_NAMES } from '../utils/constants';
import { db } from '../firebase';
import {
    doc, getDoc, updateDoc, collection, query, where, getDocs,
    setDoc, serverTimestamp
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';

const DARAJA_FIELDS = [
    {
        key: 'consumerKey',
        label: 'Consumer Key',
        placeholder: 'e.g. 3fA9b...',
        help: 'From your Daraja app on developer.safaricom.co.ke'
    },
    {
        key: 'consumerSecret',
        label: 'Consumer Secret',
        placeholder: 'e.g. kQ8zW...',
        help: 'Keep this secret — never share it publicly',
        secret: true
    },
    {
        key: 'shortcode',
        label: 'Paybill / Shortcode',
        placeholder: 'e.g. 174379',
        help: 'The Paybill number parents will use'
    },
    {
        key: 'passkey',
        label: 'Lipa na M-Pesa Passkey',
        placeholder: 'e.g. bfb279f9...',
        help: 'Provided by Safaricom with your Paybill',
        secret: true
    },
    {
        key: 'initiatorName',
        label: 'Initiator Name (optional)',
        placeholder: 'e.g. testapi',
        help: 'Only required if you plan to use B2C payouts'
    },
    {
        key: 'initiatorPassword',
        label: 'Initiator Password (optional)',
        placeholder: '••••••••',
        help: 'Only required if you plan to use B2C payouts',
        secret: true
    },
    {
        key: 'callbackUrl',
        label: 'Callback URL (optional)',
        placeholder: 'https://yourdomain.com/api/mpesa-callback',
        help: 'Leave blank to use the platform default'
    },
    {
        key: 'environment',
        label: 'Environment',
        placeholder: '',
        help: 'Sandbox for testing, Production for live payments',
        type: 'select',
        options: [
            { value: 'sandbox', label: 'Sandbox (testing)' },
            { value: 'production', label: 'Production (live)' }
        ]
    }
];

// ---------------------------------------------------------------------------
// Cloudinary unsigned upload
// ---------------------------------------------------------------------------
const CLOUDINARY_CLOUD_NAME = process.env.REACT_APP_CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_UPLOAD_PRESET = process.env.REACT_APP_CLOUDINARY_UPLOAD_PRESET;

/**
 * Upload a File to Cloudinary using an unsigned upload preset.
 * @param {File} file
 * @param {string} folder   e.g. `schools/${schoolId}/branding`
 * @returns {Promise<string>} secure_url
 */
async function uploadToCloudinary(file, folder) {
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
        throw new Error(
            'Cloudinary is not configured. Set REACT_APP_CLOUDINARY_CLOUD_NAME and ' +
            'REACT_APP_CLOUDINARY_UPLOAD_PRESET.'
        );
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    if (folder) formData.append('folder', folder);

    const res = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`,
        { method: 'POST', body: formData }
    );
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Cloudinary upload failed (${res.status}): ${text || res.statusText}`);
    }
    const json = await res.json();
    if (!json.secure_url) {
        throw new Error('Cloudinary response missing secure_url');
    }
    return json.secure_url;
}

export default function SchoolProfile() {
    const navigate = useNavigate();
    const { currentUser, userData } = useAuth();
    const {
        isOnline,
        saveToIndexedDB,
        getFromIndexedDB,
        addToSyncQueue
    } = useSync();

    const [schoolData, setSchoolData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [savingDaraja, setSavingDaraja] = useState(false);
    const [admins, setAdmins] = useState([]);
    const [activeTab, setActiveTab] = useState('general');
    const [usingCachedData, setUsingCachedData] = useState(false);

    // Daraja configuration status (fetched from parent doc, NOT from the private subcollection)
    const [darajaConfigured, setDarajaConfigured] = useState(false);
    const [darajaShortcode, setDarajaShortcode] = useState('');
    const [darajaEnvironment, setDarajaEnvironment] = useState('sandbox');
    const [darajaUpdatedAt, setDarajaUpdatedAt] = useState(null);
    const [showResetConfirm, setShowResetConfirm] = useState(false);

    // Form state — prefilled from environment variables when available
    const [darajaForm, setDarajaForm] = useState({
        consumerKey: process.env.REACT_APP_MPESA_CONSUMER_KEY || '',
        consumerSecret: process.env.REACT_APP_MPESA_CONSUMER_SECRET || process.env.REACT_APP_MPESA_SECRET_KEY || '',
        shortcode: process.env.REACT_APP_MPESA_SHORTCODE || '',
        passkey: process.env.REACT_APP_MPESA_PASSKEY || '',
        initiatorName: process.env.REACT_APP_MPESA_INITIATOR_NAME || '',
        initiatorPassword: '',
        callbackUrl: '',
        environment: process.env.REACT_APP_MPESA_ENVIRONMENT || 'sandbox'
    });

    const [formData, setFormData] = useState({
        name: '',
        schoolType: 'secondary',
        curriculum: 'cbc',
        highestLevel: 'lower-secondary',
        motto: '',
        about: '',
        country: '',
        city: '',
        state: '',
        postalCode: '',
        address: '',
        phone: '',
        email: '',
        website: '',
        academicStart: '',
        academicEnd: '',
        numTerms: 3,
        currentTerm: 1,
        gradingSystem: 'competency',
        coreSubjects: '',
        optionalSubjects: '',
        termStart: '',       // <-- ADDED
        nextTermStart: '',
        currentTermEnd: '',
        language: 'en',
        timezone: 'UTC+3',
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '12h',
        enableNotifications: true,
        enableSMS: true,
        enableBackup: true
    });

    const [useCustomClasses, setUseCustomClasses] = useState(false);
    const [customClasses, setCustomClasses] = useState([]);
    const [newClassLevel, setNewClassLevel] = useState('lower-primary');
    const [newClassBase, setNewClassBase] = useState('Grade 1');
    const [newClassLabel, setNewClassLabel] = useState('');

    const [useCustomSubjects, setUseCustomSubjects] = useState(false);
    const [customSubjects, setCustomSubjects] = useState([]);
    const [newSubjectLevel, setNewSubjectLevel] = useState('lower-primary');
    const [newSubjectName, setNewSubjectName] = useState('');

    const fileInputRef = useRef(null);
    const stampInputRef = useRef(null);
    const principalSignatureInputRef = useRef(null);

    const availableLevels = [
        { value: 'pre-primary', label: 'Pre-Primary' },
        { value: 'lower-primary', label: 'Lower Primary' },
        { value: 'upper-primary', label: 'Upper Primary' },
        { value: 'junior-school', label: 'Junior School' },
        { value: 'senior-school', label: 'Senior School' }
    ];

    // -----------------------------------------------------------------------
    // Resolve the list of classes the school actually uses.
    // Custom classes win; LEVEL_CLASSES is the fallback.
    // -----------------------------------------------------------------------
    const resolveClassesForDisplay = () => {
        if (useCustomClasses && customClasses.length > 0) {
            return customClasses.map((c) => ({
                className: c.className,
                level: c.level,
                levelDisplay: LEVEL_DISPLAY_NAMES[c.level] || c.level,
                isCustom: true
            }));
        }
        // Fallback to built-in classes across every level
        const rows = [];
        Object.keys(LEVEL_CLASSES).forEach((level) => {
            (LEVEL_CLASSES[level] || []).forEach((className) => {
                rows.push({
                    className,
                    level,
                    levelDisplay: LEVEL_DISPLAY_NAMES[level] || level,
                    isCustom: false
                });
            });
        });
        return rows;
    };

    // ---- Load school data ----
    useEffect(() => {
        if (currentUser && userData) {
            loadSchoolData();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser, userData, isOnline]);

    const loadSchoolData = async () => {
        setLoading(true);
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) throw new Error('No school found for this user');

            const cachedSchool = await getFromIndexedDB('school_data', schoolId);
            if (cachedSchool) {
                setSchoolData(cachedSchool);
                populateFormData(cachedSchool);
                setDarajaConfigured(!!cachedSchool.darajaConfigured);
                setDarajaShortcode(cachedSchool.paybillNumber || '');
                setDarajaEnvironment(cachedSchool.darajaEnvironment || 'sandbox');
                setUsingCachedData(true);
                await loadAdmins(schoolId);
                setLoading(false);
            }

            if (isOnline) {
                const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
                if (schoolDoc.exists()) {
                    const data = schoolDoc.data();
                    setSchoolData({ id: schoolDoc.id, ...data });
                    populateFormData(data);
                    setDarajaConfigured(!!data.darajaConfigured);
                    setDarajaShortcode(data.paybillNumber || '');
                    setDarajaEnvironment(data.darajaEnvironment || 'sandbox');
                    setDarajaUpdatedAt(data.darajaUpdatedAt || null);
                    setUsingCachedData(false);
                    await saveToIndexedDB('school_data', { id: schoolId, ...data });
                    await loadAdmins(schoolId);
                } else {
                    throw new Error('School not found');
                }
            }
        } catch (error) {
            console.error('Error loading school data:', error);
            showNotification('Failed to load school data: ' + error.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    const populateFormData = (data) => {
        setFormData({
            name: data.name || '',
            schoolType: data.schoolType || 'secondary',
            curriculum: data.curriculum || 'cbc',
            highestLevel: data.highestLevel || data.level || 'lower-secondary',
            motto: data.motto || '',
            about: data.about || '',
            country: data.country || '',
            city: data.city || '',
            state: data.state || '',
            postalCode: data.postalCode || '',
            address: data.address || '',
            phone: data.phone || '',
            email: data.email || '',
            website: data.website || '',
            academicStart: data.academicYear?.start || '',
            academicEnd: data.academicYear?.end || '',
            numTerms: data.numTerms || 3,
            currentTerm: data.currentTerm || 1,
            gradingSystem: data.gradingSystem || 'competency',
            coreSubjects: data.coreSubjects ? data.coreSubjects.join(', ') : '',
            optionalSubjects: data.optionalSubjects ? data.optionalSubjects.join(', ') : '',
            termStart: data.termStart || '',              // <-- ADDED
            nextTermStart: data.nextTermStart || '',
            currentTermEnd: data.currentTermEnd || '',
            language: data.language || 'en',
            timezone: data.timezone || 'UTC+3',
            dateFormat: data.dateFormat || 'DD/MM/YYYY',
            timeFormat: data.timeFormat || '12h',
            enableNotifications: data.enableNotifications !== false,
            enableSMS: data.enableSMS !== false,
            enableBackup: data.enableBackup !== false
        });
        setUseCustomClasses(!!data.useCustomClasses);
        setCustomClasses(data.customClasses || []);
        setUseCustomSubjects(!!data.useCustomSubjects);
        setCustomSubjects(data.customSubjects || []);
    };

    const loadAdmins = async (schoolId) => {
        try {
            if (!isOnline) {
                const cachedAdmins = await getFromIndexedDB('admins_cache', schoolId);
                if (cachedAdmins) {
                    setAdmins(cachedAdmins);
                    return;
                }
            }
            const q = query(
                collection(db, 'users'),
                where('schoolId', '==', schoolId),
                where('role', 'in', ['admin', 'super-admin', 'teacher', 'staff'])
            );
            const snapshot = await getDocs(q);
            const adminList = [];
            snapshot.forEach((d) => adminList.push({ id: d.id, ...d.data() }));
            setAdmins(adminList);
            await saveToIndexedDB('admins_cache', adminList);
        } catch (error) {
            console.error('Error loading admins:', error);
            const cachedAdmins = await getFromIndexedDB('admins_cache', schoolId);
            if (cachedAdmins) setAdmins(cachedAdmins);
            else showNotification('Failed to load administrators', 'error');
        }
    };

    // ---- Form handlers ----
    const handleInputChange = (e) => {
        const { id, value, type, checked } = e.target;
        setFormData((prev) => ({
            ...prev,
            [id]: type === 'checkbox' ? checked : value
        }));
    };

    const handleDarajaChange = (e) => {
        const { id, value } = e.target;
        setDarajaForm((prev) => ({ ...prev, [id]: value }));
    };

    // ---- Save general school profile ----
    const handleSave = async () => {
        if (saving) return;
        setSaving(true);
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) throw new Error('No school found');

            const updatedData = {
                schoolType: formData.schoolType,
                curriculum: formData.curriculum,
                highestLevel: formData.highestLevel,
                motto: formData.motto.trim(),
                about: formData.about.trim(),
                country: formData.country.trim(),
                city: formData.city.trim(),
                state: formData.state.trim(),
                postalCode: formData.postalCode.trim(),
                address: formData.address.trim(),
                phone: formData.phone.trim(),
                email: formData.email.trim(),
                website: formData.website.trim(),
                academicYear: { start: formData.academicStart, end: formData.academicEnd },
                numTerms: parseInt(formData.numTerms, 10),
                currentTerm: parseInt(formData.currentTerm, 10),
                gradingSystem: formData.gradingSystem,
                coreSubjects: formData.coreSubjects.split(',').map((s) => s.trim()).filter(Boolean),
                optionalSubjects: formData.optionalSubjects.split(',').map((s) => s.trim()).filter(Boolean),
                termStart: formData.termStart,                // <-- ADDED
                nextTermStart: formData.nextTermStart,
                currentTermEnd: formData.currentTermEnd,
                language: formData.language,
                timezone: formData.timezone,
                dateFormat: formData.dateFormat,
                timeFormat: formData.timeFormat,
                enableNotifications: formData.enableNotifications,
                enableSMS: formData.enableSMS,
                enableBackup: formData.enableBackup,
                useCustomClasses,
                customClasses,
                useCustomSubjects,
                customSubjects,
                updatedAt: new Date().toISOString()
            };

            if (isOnline) {
                await updateDoc(doc(db, 'schools', schoolId), updatedData);
                showNotification('School profile saved successfully!', 'success');
            } else {
                await addToSyncQueue('schools', 'update', { id: schoolId, ...updatedData });
                showNotification('School profile saved offline - will sync when online', 'info');
            }

            setSchoolData((prev) => ({ ...prev, ...updatedData }));
            await saveToIndexedDB('school_data', { id: schoolId, ...updatedData });
        } catch (error) {
            console.error('Error saving school data:', error);
            showNotification('Failed to save school profile: ' + error.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    // ---- Save Daraja credentials ----
    const handleSaveDaraja = async () => {
        if (savingDaraja) return;

        const required = ['consumerKey', 'consumerSecret', 'shortcode', 'passkey'];
        for (const key of required) {
            if (!darajaForm[key]?.trim()) {
                showNotification(`Please fill in all required fields (missing: ${key})`, 'warning');
                return;
            }
        }

        if (!isOnline) {
            showNotification('You must be online to save Daraja credentials', 'warning');
            return;
        }

        setSavingDaraja(true);
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) throw new Error('No school found');

            await setDoc(
                doc(db, 'schools', schoolId, 'private', 'daraja'),
                {
                    consumerKey: darajaForm.consumerKey.trim(),
                    consumerSecret: darajaForm.consumerSecret.trim(),
                    shortcode: darajaForm.shortcode.trim(),
                    passkey: darajaForm.passkey.trim(),
                    initiatorName: darajaForm.initiatorName?.trim() || '',
                    initiatorPassword: darajaForm.initiatorPassword?.trim() || '',
                    callbackUrl: darajaForm.callbackUrl?.trim() || '',
                    environment: darajaForm.environment || 'sandbox',
                    updatedAt: serverTimestamp(),
                    updatedBy: currentUser?.uid || ''
                },
                { merge: true }
            );

            await updateDoc(doc(db, 'schools', schoolId), {
                darajaConfigured: true,
                darajaEnvironment: darajaForm.environment || 'sandbox',
                paybillNumber: darajaForm.shortcode.trim(),
                darajaUpdatedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });

            setDarajaConfigured(true);
            setDarajaShortcode(darajaForm.shortcode.trim());
            setDarajaEnvironment(darajaForm.environment || 'sandbox');
            setDarajaUpdatedAt(new Date().toISOString());
            setDarajaForm({
                consumerKey: '',
                consumerSecret: '',
                shortcode: darajaForm.shortcode.trim(),
                passkey: '',
                initiatorName: '',
                initiatorPassword: '',
                callbackUrl: '',
                environment: darajaForm.environment || 'sandbox'
            });

            showNotification('Daraja credentials saved securely', 'success');
        } catch (error) {
            console.error('Error saving Daraja credentials:', error);
            showNotification('Failed to save Daraja credentials: ' + error.message, 'error');
        } finally {
            setSavingDaraja(false);
        }
    };

    const handleResetDarajaForm = () => {
        setShowResetConfirm(false);
        setDarajaForm({
            consumerKey: process.env.REACT_APP_MPESA_CONSUMER_KEY || '',
            consumerSecret: process.env.REACT_APP_MPESA_CONSUMER_SECRET || process.env.REACT_APP_MPESA_SECRET_KEY || '',
            shortcode: darajaShortcode || process.env.REACT_APP_MPESA_SHORTCODE || '',
            passkey: process.env.REACT_APP_MPESA_PASSKEY || '',
            initiatorName: process.env.REACT_APP_MPESA_INITIATOR_NAME || '',
            initiatorPassword: '',
            callbackUrl: '',
            environment: darajaEnvironment || process.env.REACT_APP_MPESA_ENVIRONMENT || 'sandbox'
        });
        showNotification(
            'Form reset to environment defaults. Save to update credentials.',
            'info'
        );
    };

    // ============================================================
    // Logo upload (Cloudinary)
    // ============================================================
    const handleLogoUpload = () => {
        if (!isOnline) {
            showNotification('You are offline. Please connect to the internet to upload a logo.', 'warning');
            return;
        }
        fileInputRef.current.click();
    };

    const handleFileChange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            showNotification('Image must be less than 5MB', 'error');
            e.target.value = '';
            return;
        }
        const schoolId = userData?.schoolId;
        if (!schoolId) return;
        setSaving(true);
        try {
            const secureUrl = await uploadToCloudinary(file, `schools/${schoolId}/branding`);
            await updateDoc(doc(db, 'schools', schoolId), {
                logoUrl: secureUrl,
                updatedAt: new Date().toISOString()
            });
            setSchoolData((prev) => ({ ...prev, logoUrl: secureUrl }));
            showNotification('Logo uploaded successfully!', 'success');
        } catch (error) {
            console.error('Error uploading logo:', error);
            showNotification('Failed to upload logo: ' + error.message, 'error');
        } finally {
            setSaving(false);
            e.target.value = '';
        }
    };

    // ============================================================
    // Stamp upload (Cloudinary)
    // ============================================================
    const handleStampUpload = () => {
        if (!isOnline) {
            showNotification('You must be online to upload a stamp.', 'warning');
            return;
        }
        stampInputRef.current.click();
    };

    const handleStampFileChange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            showNotification('Stamp image must be less than 2MB', 'error');
            e.target.value = '';
            return;
        }
        const schoolId = userData?.schoolId;
        if (!schoolId) return;
        setSaving(true);
        try {
            const secureUrl = await uploadToCloudinary(file, `schools/${schoolId}/branding`);
            await updateDoc(doc(db, 'schools', schoolId), {
                stampUrl: secureUrl,
                updatedAt: new Date().toISOString()
            });
            setSchoolData((prev) => ({ ...prev, stampUrl: secureUrl }));
            showNotification('Stamp uploaded successfully!', 'success');
        } catch (error) {
            console.error('Error uploading stamp:', error);
            showNotification('Failed to upload stamp: ' + error.message, 'error');
        } finally {
            setSaving(false);
            e.target.value = '';
        }
    };

    // ============================================================
    // Principal signature upload (Cloudinary)
    // ============================================================
    const handlePrincipalSignatureUpload = () => {
        if (!isOnline) {
            showNotification('You must be online to upload a signature.', 'warning');
            return;
        }
        principalSignatureInputRef.current.click();
    };

    const handlePrincipalSignatureFileChange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            showNotification('Signature image must be less than 2MB', 'error');
            e.target.value = '';
            return;
        }
        const schoolId = userData?.schoolId;
        if (!schoolId) return;
        setSaving(true);
        try {
            const secureUrl = await uploadToCloudinary(file, `schools/${schoolId}/branding`);
            await updateDoc(doc(db, 'schools', schoolId), {
                principalSignatureUrl: secureUrl,
                updatedAt: new Date().toISOString()
            });
            setSchoolData((prev) => ({ ...prev, principalSignatureUrl: secureUrl }));
            showNotification('Principal signature uploaded successfully!', 'success');
        } catch (error) {
            console.error('Error uploading signature:', error);
            showNotification('Failed to upload signature: ' + error.message, 'error');
        } finally {
            setSaving(false);
            e.target.value = '';
        }
    };

    // ---- Admins ----
    const handleAddAdmin = async (e) => {
        e.preventDefault();
        const form = e.target;
        const firstName = form.adminFirstName.value.trim();
        const lastName = form.adminLastName.value.trim();
        const email = form.adminEmail.value.trim();
        const role = form.adminRole.value;
        const phone = form.adminPhone.value.trim();

        if (!firstName || !lastName || !email) {
            showNotification('Please fill in all required fields', 'error');
            return;
        }
        const schoolId = userData?.schoolId;
        if (!schoolId) return;
        setSaving(true);
        try {
            if (!isOnline) {
                showNotification('You are offline. Please connect to the internet to add an admin.', 'warning');
                setSaving(false);
                return;
            }
            const userSnapshot = await getDocs(
                query(collection(db, 'users'), where('email', '==', email))
            );
            if (userSnapshot.empty) {
                showNotification('User not found. Please ensure the user has registered first.', 'error');
                setSaving(false);
                return;
            }
            const userDoc = userSnapshot.docs[0];
            await updateDoc(doc(db, 'users', userDoc.id), {
                role,
                schoolId,
                updatedAt: new Date().toISOString()
            });
            await loadAdmins(schoolId);
            form.reset();
            document.getElementById('adminModal').classList.remove('active');
            showNotification('Administrator added successfully!', 'success');
        } catch (error) {
            console.error('Error adding admin:', error);
            showNotification('Failed to add administrator: ' + error.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleRemoveAdmin = async (uid) => {
        if (!window.confirm('Are you sure you want to remove this administrator?')) return;
        const schoolId = userData?.schoolId;
        if (!schoolId) return;
        setSaving(true);
        try {
            if (!isOnline) {
                showNotification('You are offline. Please connect to the internet to remove an admin.', 'warning');
                setSaving(false);
                return;
            }
            await updateDoc(doc(db, 'users', uid), {
                role: 'staff',
                updatedAt: new Date().toISOString()
            });
            await loadAdmins(schoolId);
            showNotification('Administrator removed successfully.', 'success');
        } catch (error) {
            console.error('Error removing admin:', error);
            showNotification('Failed to remove administrator: ' + error.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    const showNotification = (message, type = 'info') => {
        const colors = { success: '#27ae60', error: '#e74c3c', warning: '#f39c12', info: '#3498db' };
        const iconMap = {
            success: 'check-circle', error: 'exclamation-circle',
            warning: 'exclamation-triangle', info: 'info-circle'
        };
        const el = document.createElement('div');
        el.className = 'custom-notification';
        el.style.backgroundColor = colors[type] || colors.info;
        el.innerHTML = `<i class="fas fa-${iconMap[type] || 'info-circle'}"></i><span>${message}</span>`;
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => el.parentNode && el.parentNode.removeChild(el), 300);
        }, 4000);
    };

    if (loading) return <LoadingSpinner fullScreen text="Loading school profile..." />;

    const renderAdmins = () => {
        if (admins.length === 0) {
            return (
                <div className="empty-state" style={{ textAlign: 'center', padding: 40, color: 'var(--gray)', gridColumn: '1 / -1' }}>
                    <i className="fas fa-users" style={{ fontSize: 48, display: 'block', marginBottom: 15, color: 'var(--border)' }}></i>
                    <h3 style={{ color: 'var(--secondary)' }}>No Administrators Found</h3>
                    <p>Add administrators to help manage the school.</p>
                </div>
            );
        }
        return admins.map((admin) => (
            <div key={admin.id} className="admin-card">
                <div className="admin-avatar">
                    {admin.firstName?.[0] || 'A'}{admin.lastName?.[0] || ''}
                </div>
                <div className="admin-info">
                    <div className="admin-name">{admin.firstName || ''} {admin.lastName || ''}</div>
                    <div className="admin-role">{admin.role ? admin.role.replace('-', ' ').toUpperCase() : 'Staff'}</div>
                    <div className="admin-email">{admin.email || ''}</div>
                </div>
                <div className="admin-actions">
                    {admin.uid !== currentUser?.uid ? (
                        <>
                            <button className="edit-admin" onClick={() => showNotification('Edit admin functionality coming soon.', 'info')}>
                                <i className="fas fa-edit"></i>
                            </button>
                            <button className="remove-admin" onClick={() => handleRemoveAdmin(admin.uid)}>
                                <i className="fas fa-trash"></i>
                            </button>
                        </>
                    ) : (
                        <span style={{ fontSize: 11, color: 'var(--gray)' }}>(You)</span>
                    )}
                </div>
            </div>
        ));
    };

    // ---- Finance tab render ----
    const renderFinanceTab = () => {
        const isReadOnly = darajaConfigured;

        return (
            <div className="form-section active">
                <div className="finance-settings-header">
                    <h3 style={{ fontSize: 18, color: 'var(--secondary)', marginBottom: 10 }}>
                        <i className="fas fa-key" style={{ color: 'var(--primary)' }}></i> M-Pesa Daraja Credentials
                    </h3>
                    <p style={{ color: 'var(--gray)', fontSize: 14, marginBottom: 20 }}>
                        Enter the Daraja API credentials from your own Safaricom account.
                        We store them encrypted-at-rest in a private location that no client can read back —
                        not even you after saving.
                    </p>
                </div>

                {isReadOnly && (
                    <div className="fee-info-box" style={{ background: '#e8f5e9', borderLeftColor: '#2e7d32' }}>
                        <h4 style={{ color: '#1b5e20' }}>
                            <i className="fas fa-check-circle"></i> Credentials Configured
                        </h4>
                        <ul>
                            <li><i className="fas fa-check-circle"></i> <span><strong>Paybill / Shortcode:</strong> {darajaShortcode}</span></li>
                            <li><i className="fas fa-check-circle"></i> <span><strong>Environment:</strong> {darajaEnvironment}</span></li>
                            {darajaUpdatedAt && (
                                <li>
                                    <i className="fas fa-clock"></i>
                                    <span><strong>Last updated:</strong> {new Date(darajaUpdatedAt).toLocaleString()}</span>
                                </li>
                            )}
                            <li>
                                <i className="fas fa-lock"></i>
                                <span>Your keys are stored securely and cannot be viewed again. To rotate them, click <strong>Replace Credentials</strong> below.</span>
                            </li>
                        </ul>
                    </div>
                )}

                {DARAJA_FIELDS.map((field) => {
                    const value = darajaForm[field.key] ?? '';
                    const disabled = isReadOnly;

                    return (
                        <div className="form-group" key={field.key} style={{ marginBottom: 18 }}>
                            <label style={{ display: 'block', fontWeight: 600, marginBottom: 5 }}>
                                {field.label}
                                {['consumerKey', 'consumerSecret', 'shortcode', 'passkey'].includes(field.key) && (
                                    <span className="required" style={{ color: 'var(--danger)' }}> *</span>
                                )}
                            </label>

                            {field.type === 'select' ? (
                                <select
                                    id={field.key}
                                    value={value || field.options[0].value}
                                    onChange={handleDarajaChange}
                                    disabled={disabled}
                                    style={disabled ? disabledFieldStyle : undefined}
                                >
                                    {field.options.map((opt) => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    type={field.secret ? 'password' : 'text'}
                                    id={field.key}
                                    value={value}
                                    onChange={handleDarajaChange}
                                    placeholder={disabled ? '••••••••••••' : field.placeholder}
                                    disabled={disabled}
                                    autoComplete="off"
                                    style={disabled ? disabledFieldStyle : undefined}
                                />
                            )}

                            <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 4 }}>
                                {field.help}
                            </div>
                        </div>
                    );
                })}

                <div style={{
                    display: 'flex', gap: 12, marginTop: 25,
                    paddingTop: 20, borderTop: '1px solid var(--border)',
                    flexWrap: 'wrap'
                }}>
                    {!isReadOnly && (
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={handleSaveDaraja}
                            disabled={savingDaraja || !isOnline}
                            style={{
                                padding: '12px 24px', border: 'none', borderRadius: 8,
                                fontWeight: 600, cursor: (savingDaraja || !isOnline) ? 'not-allowed' : 'pointer',
                                background: 'var(--primary)', color: 'white',
                                display: 'inline-flex', alignItems: 'center', gap: 8,
                                opacity: (savingDaraja || !isOnline) ? 0.7 : 1
                            }}
                        >
                            {savingDaraja ? (
                                <>
                                    <span className="loading-spinner" style={spinnerStyle}></span>
                                    Saving…
                                </>
                            ) : (
                                <>
                                    <i className="fas fa-save"></i> Save Credentials
                                </>
                            )}
                        </button>
                    )}

                    {isReadOnly && (
                        <button
                            type="button"
                            className="btn btn-outline"
                            onClick={() => setShowResetConfirm(true)}
                            style={{
                                padding: '12px 24px', borderRadius: 8, fontWeight: 600,
                                background: 'transparent', color: 'var(--danger)',
                                border: '2px solid var(--danger)', cursor: 'pointer',
                                display: 'inline-flex', alignItems: 'center', gap: 8
                            }}
                        >
                            <i className="fas fa-rotate"></i> Replace Credentials
                        </button>
                    )}
                </div>

                {!isOnline && (
                    <div style={{ marginTop: 15, padding: 12, background: '#fff3cd', color: '#856404', borderRadius: 8, fontSize: 13 }}>
                        <i className="fas fa-wifi-slash"></i> You must be online to save Daraja credentials.
                    </div>
                )}

                {showResetConfirm && (
                    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && setShowResetConfirm(false)}>
                        <div className="modal" style={{ maxWidth: 460 }}>
                            <div className="modal-header">
                                <h2>Replace Daraja Credentials?</h2>
                                <button className="modal-close" onClick={() => setShowResetConfirm(false)}>
                                    <i className="fas fa-times"></i>
                                </button>
                            </div>
                            <p style={{ color: 'var(--gray)', fontSize: 14, lineHeight: 1.6 }}>
                                You will be asked to enter new credentials from scratch.
                                The previous keys will stay active until you save the new ones.
                                No interruption to parent payments.
                            </p>
                            <div className="modal-footer">
                                <button className="btn btn-outline" onClick={() => setShowResetConfirm(false)}>Cancel</button>
                                <button className="btn btn-danger" onClick={handleResetDarajaForm}>
                                    <i className="fas fa-rotate"></i> Replace Now
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <Layout title="School Profile">
            <style>{styles}</style>

            {usingCachedData && isOnline && (
                <div style={cachedBannerStyle}>
                    <i className="fas fa-database"></i>
                    <span>Showing cached data. Syncing in background…</span>
                </div>
            )}

            {/* Hidden file inputs — all three */}
            <input
                type="file"
                ref={fileInputRef}
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleFileChange}
            />
            <input
                type="file"
                ref={stampInputRef}
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleStampFileChange}
            />
            <input
                type="file"
                ref={principalSignatureInputRef}
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handlePrincipalSignatureFileChange}
            />

            <div className="profile-card">
                {/* Profile header */}
                <div className="profile-header">
                    <div className="profile-avatar">
                        <img
                            src={schoolData?.logoUrl || 'https://ui-avatars.com/api/?name=School&background=1a237e&color=fff&size=120'}
                            alt="School Logo"
                        />
                        <button className="upload-btn" onClick={handleLogoUpload} title="Upload Logo">
                            <i className="fas fa-camera"></i>
                        </button>
                    </div>
                    <div className="profile-info">
                        <h2>{schoolData?.name || 'Unnamed School'}</h2>
                        <div className="school-id">School ID: {schoolData?.schoolId || schoolData?.id || 'N/A'}</div>
                        <span className={`school-status ${schoolData?.subscriptionStatus || 'pending'}`}>
                            {schoolData?.subscriptionStatus
                                ? schoolData.subscriptionStatus.charAt(0).toUpperCase() + schoolData.subscriptionStatus.slice(1)
                                : 'Pending'}
                        </span>
                    </div>
                </div>

                {/* Tabs */}
                <div className="tabs">
                    {[
                        { key: 'general', icon: 'fa-info-circle', label: 'General' },
                        { key: 'address', icon: 'fa-map-marker-alt', label: 'Address' },
                        { key: 'academic', icon: 'fa-graduation-cap', label: 'Academic' },
                        { key: 'class-teachers', icon: 'fa-chalkboard-user', label: 'Class Teachers' },
                        { key: 'finance', icon: 'fa-key', label: 'Finance' },
                        { key: 'admins', icon: 'fa-users-cog', label: 'Admins' },
                        { key: 'settings', icon: 'fa-cog', label: 'Settings' }
                    ].map((tab) => (
                        <button
                            key={tab.key}
                            className={`tab ${activeTab === tab.key ? 'active' : ''}`}
                            onClick={() => setActiveTab(tab.key)}
                        >
                            <i className={`fas ${tab.icon}`}></i> {tab.label}
                        </button>
                    ))}
                </div>

                {/* ----- Tab: General ----- */}
                {activeTab === 'general' && (
                    <div className="form-section active">
                        <div className="form-row">
                            <div className="form-group">
                                <label>School Name <span className="required">*</span></label>
                                <input type="text" id="name" value={formData.name} readOnly aria-readonly="true" />
                            </div>
                            <div className="form-group">
                                <label>School Type</label>
                                <select id="schoolType" value={formData.schoolType} onChange={handleInputChange}>
                                    <option value="primary">Primary School</option>
                                    <option value="secondary">Secondary School</option>
                                    <option value="combined">Combined School</option>
                                    <option value="college">College</option>
                                    <option value="university">University</option>
                                </select>
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Curriculum</label>
                                <select id="curriculum" value={formData.curriculum} onChange={handleInputChange}>
                                    <option value="cbc">CBC (Competency-Based Curriculum)</option>
                                    <option value="cbe">CBE (Competency-Based Education)</option>
                                    <option value="8-4-4">8-4-4 System</option>
                                    <option value="igcse">IGCSE</option>
                                    <option value="ib">International Baccalaureate</option>
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Highest School Level</label>
                                <select id="highestLevel" value={formData.highestLevel} onChange={handleInputChange}>
                                    {availableLevels.map((l) => (
                                        <option key={l.value} value={l.value}>{l.label}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="form-group">
                            <label>School Motto</label>
                            <input type="text" id="motto" value={formData.motto} onChange={handleInputChange} placeholder="Enter school motto" />
                        </div>
                        <div className="form-group">
                            <label>About School</label>
                            <textarea id="about" rows="3" value={formData.about} onChange={handleInputChange} placeholder="Describe your school…" />
                        </div>

                        {/* Stamp + Signature uploads */}
                        <div className="form-row">
                            <div className="form-group">
                                <label>Official School Stamp</label>
                                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                    <div style={{
                                        width: 90, height: 90, border: '2px dashed var(--border)',
                                        borderRadius: 12, display: 'flex', alignItems: 'center',
                                        justifyContent: 'center', overflow: 'hidden', background: '#fafbfc',
                                        flexShrink: 0,
                                    }}>
                                        {schoolData?.stampUrl ? (
                                            <img
                                                src={schoolData.stampUrl}
                                                alt="Stamp"
                                                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                                            />
                                        ) : (
                                            <i className="fas fa-stamp" style={{ fontSize: 32, color: '#ccc' }} />
                                        )}
                                    </div>
                                    <div>
                                        <button
                                            type="button"
                                            className="btn btn-primary"
                                            onClick={handleStampUpload}
                                            disabled={saving || !isOnline}
                                            style={{ padding: '8px 16px', fontSize: 13 }}
                                        >
                                            <i className="fas fa-upload"></i> Upload Stamp
                                        </button>
                                        <p style={{ fontSize: 11, color: 'var(--gray)', marginTop: 6, maxWidth: 240 }}>
                                            PNG with transparent background recommended. Rotated 45° on the report form.
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Principal's Signature</label>
                                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                    <div style={{
                                        width: 140, height: 90, border: '2px dashed var(--border)',
                                        borderRadius: 12, display: 'flex', alignItems: 'center',
                                        justifyContent: 'center', overflow: 'hidden', background: '#fafbfc',
                                        flexShrink: 0,
                                    }}>
                                        {schoolData?.principalSignatureUrl ? (
                                            <img
                                                src={schoolData.principalSignatureUrl}
                                                alt="Signature"
                                                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                                            />
                                        ) : (
                                            <i className="fas fa-signature" style={{ fontSize: 32, color: '#ccc' }} />
                                        )}
                                    </div>
                                    <div>
                                        <button
                                            type="button"
                                            className="btn btn-primary"
                                            onClick={handlePrincipalSignatureUpload}
                                            disabled={saving || !isOnline}
                                            style={{ padding: '8px 16px', fontSize: 13 }}
                                        >
                                            <i className="fas fa-upload"></i> Upload Signature
                                        </button>
                                        <p style={{ fontSize: 11, color: 'var(--gray)', marginTop: 6, maxWidth: 240 }}>
                                            PNG with transparent background. Placed above the principal's name.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* ----- Tab: Address ----- */}
                {activeTab === 'address' && (
                    <div className="form-section active">
                        <div className="form-row">
                            <div className="form-group"><label>Country</label>
                                <input type="text" id="country" value={formData.country} onChange={handleInputChange} /></div>
                            <div className="form-group"><label>City/Town</label>
                                <input type="text" id="city" value={formData.city} onChange={handleInputChange} /></div>
                        </div>
                        <div className="form-row">
                            <div className="form-group"><label>State/Province</label>
                                <input type="text" id="state" value={formData.state} onChange={handleInputChange} /></div>
                            <div className="form-group"><label>Postal Code</label>
                                <input type="text" id="postalCode" value={formData.postalCode} onChange={handleInputChange} /></div>
                        </div>
                        <div className="form-group"><label>Address</label>
                            <textarea id="address" rows="2" value={formData.address} onChange={handleInputChange} /></div>
                        <div className="form-row-3">
                            <div className="form-group"><label>Phone Number</label>
                                <input type="tel" id="phone" value={formData.phone} onChange={handleInputChange} /></div>
                            <div className="form-group"><label>Email</label>
                                <input type="email" id="email" value={formData.email} onChange={handleInputChange} /></div>
                            <div className="form-group"><label>Website</label>
                                <input type="url" id="website" value={formData.website} onChange={handleInputChange} placeholder="https://example.com" /></div>
                        </div>
                    </div>
                )}

                {/* ----- Tab: Class Teachers ----- */}
                {activeTab === 'class-teachers' && (
                    <div className="form-section active">
                        <h3 style={{ fontSize: 18, color: 'var(--secondary)', marginBottom: 20 }}>Assign Class Teachers</h3>
                        <p style={{ fontSize: 13, color: 'var(--gray)', marginBottom: 20 }}>
                            {useCustomClasses && customClasses.length > 0
                                ? 'Showing your customised classes. Assign a teacher to each.'
                                : 'Using default system classes. Enable customised classes in the Academic tab to override these.'}
                        </p>
                        <div className="table-container">
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr>
                                        <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid var(--border)' }}>Class</th>
                                        <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid var(--border)' }}>Level</th>
                                        <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid var(--border)' }}>Assigned Teacher</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {resolveClassesForDisplay().map(({ className, levelDisplay, isCustom }) => {
                                        const assignment = schoolData?.classTeachers?.[className];
                                        return (
                                            <tr key={className} style={{ borderBottom: '1px solid var(--border)' }}>
                                                <td style={{ padding: '12px' }}>
                                                    {className}
                                                    {isCustom && (
                                                        <span style={{
                                                            marginLeft: 8, fontSize: 10, fontWeight: 600,
                                                            padding: '2px 8px', borderRadius: 8,
                                                            background: '#eef2ff', color: 'var(--primary)'
                                                        }}>
                                                            Custom
                                                        </span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '12px', fontSize: 13, color: 'var(--gray)' }}>
                                                    {levelDisplay}
                                                </td>
                                                <td style={{ padding: '12px' }}>
                                                    <select
                                                        onChange={async (e) => {
                                                            const newTeacherId = e.target.value;
                                                            const newClassTeachers = {
                                                                ...(schoolData.classTeachers || {}),
                                                                [className]: newTeacherId
                                                            };
                                                            await updateDoc(doc(db, 'schools', schoolData.id), {
                                                                classTeachers: newClassTeachers
                                                            });
                                                            setSchoolData(prev => ({ ...prev, classTeachers: newClassTeachers }));
                                                            showNotification('Class teacher updated', 'success');
                                                        }}
                                                        value={assignment || ''}
                                                    >
                                                        <option value="">Unassigned</option>
                                                        {admins.filter(a => a.role === 'teacher').map(t => (
                                                            <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>
                                                        ))}
                                                    </select>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* ----- Tab: Academic ----- */}
                {activeTab === 'academic' && (
                    <div className="form-section active">
                        <div className="form-row">
                            <div className="form-group"><label>Academic Year Start</label>
                                <input type="date" id="academicStart" value={formData.academicStart} onChange={handleInputChange} /></div>
                            <div className="form-group"><label>Academic Year End</label>
                                <input type="date" id="academicEnd" value={formData.academicEnd} onChange={handleInputChange} /></div>
                        </div>
                        <div className="form-row-3">
                            <div className="form-group"><label>Number of Terms</label>
                                <select id="numTerms" value={formData.numTerms} onChange={handleInputChange}>
                                    <option value="2">2 Terms</option>
                                    <option value="3">3 Terms</option>
                                    <option value="4">4 Terms</option>
                                </select></div>
                            <div className="form-group"><label>Current Term</label>
                                <select id="currentTerm" value={formData.currentTerm} onChange={handleInputChange}>
                                    <option value="1">Term 1</option>
                                    <option value="2">Term 2</option>
                                    <option value="3">Term 3</option>
                                </select></div>
                            <div className="form-group"><label>Grading System</label>
                                <select id="gradingSystem" value={formData.gradingSystem} onChange={handleInputChange}>
                                    <option value="competency">Competency-Based</option>
                                    <option value="percentage">Percentage</option>
                                    <option value="letter">Letter Grade</option>
                                    <option value="gpa">GPA</option>
                                </select></div>
                        </div>
                        <div className="form-row-3">
                            <div className="form-group"><label>Term Start</label>
                                <input type="date" id="termStart" value={formData.termStart} onChange={handleInputChange} /></div>
                            <div className="form-group"><label>Current Term End</label>
                                <input type="date" id="currentTermEnd" value={formData.currentTermEnd} onChange={handleInputChange} /></div>
                            <div className="form-group"><label>Next Term Start</label>
                                <input type="date" id="nextTermStart" value={formData.nextTermStart} onChange={handleInputChange} /></div>
                        </div>
                        <div className="form-group"><label>Core Subjects</label>
                            <input type="text" id="coreSubjects" value={formData.coreSubjects} onChange={handleInputChange} placeholder="Separate with commas" /></div>
                        <div className="form-group"><label>Optional Subjects</label>
                            <input type="text" id="optionalSubjects" value={formData.optionalSubjects} onChange={handleInputChange} placeholder="Separate with commas" /></div>

                        <div style={{ marginTop: '25px', padding: '20px', background: '#f8fafc', borderRadius: '12px', border: '1px solid var(--border)' }}>
                            <h4 style={{ marginBottom: '10px', color: 'var(--secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <i className="fas fa-layer-group"></i> Class Structure & Customised Classes
                            </h4>
                            <p style={{ fontSize: '13px', color: 'var(--gray)', marginBottom: '15px' }}>
                                Toggle to use customised class names (e.g. Grade 3 Hope, Grade 3 East) in place of default system classes across all pages.
                            </p>
                            
                            <div className="form-group" style={{ marginBottom: '20px' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontWeight: '600' }}>
                                    <input
                                        type="checkbox"
                                        checked={useCustomClasses}
                                        onChange={(e) => setUseCustomClasses(e.target.checked)}
                                        style={{ width: '18px', height: '18px', accentColor: 'var(--primary)' }}
                                    />
                                    Enable Customised Classes
                                </label>
                            </div>

                            {useCustomClasses && (
                                <div style={{ borderTop: '1px solid var(--border)', paddingTop: '15px' }}>
                                    <h5 style={{ marginBottom: '10px', color: 'var(--secondary)' }}>Add Custom Class</h5>
                                    <div className="form-row-3" style={{ marginBottom: '15px' }}>
                                        <div className="form-group">
                                            <label>Select Level</label>
                                            <select
                                                value={newClassLevel}
                                                onChange={(e) => {
                                                    const lvl = e.target.value;
                                                    setNewClassLevel(lvl);
                                                    const baseList = LEVEL_CLASSES[lvl] || [];
                                                    setNewClassBase(baseList[0] || '');
                                                }}
                                                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'white' }}
                                            >
                                                {availableLevels.map(l => (
                                                    <option key={l.value} value={l.value}>{l.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="form-group">
                                            <label>Base Class</label>
                                            <select
                                                value={newClassBase}
                                                onChange={(e) => setNewClassBase(e.target.value)}
                                                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'white' }}
                                            >
                                                {(LEVEL_CLASSES[newClassLevel] || []).map(cls => (
                                                    <option key={cls} value={cls}>{cls}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="form-group">
                                            <label>Additional Label (e.g. Hope, E)</label>
                                            <div style={{ display: 'flex', gap: '8px' }}>
                                                <input
                                                    type="text"
                                                    value={newClassLabel}
                                                    onChange={(e) => setNewClassLabel(e.target.value)}
                                                    placeholder="e.g. Hope"
                                                    style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', flex: 1 }}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (!newClassBase) return;
                                                        const labelTrim = newClassLabel.trim();
                                                        const className = labelTrim ? `${newClassBase} ${labelTrim}` : newClassBase;
                                                        if (customClasses.some(c => c.level === newClassLevel && c.className === className)) {
                                                            showNotification('Class already exists for this level', 'warning');
                                                            return;
                                                        }
                                                        const newEntry = {
                                                            id: Date.now().toString(),
                                                            level: newClassLevel,
                                                            baseClass: newClassBase,
                                                            label: labelTrim,
                                                            className
                                                        };
                                                        setCustomClasses(prev => [...prev, newEntry]);
                                                        setNewClassLabel('');
                                                        showNotification(`Added class: ${className}`, 'success');
                                                    }}
                                                    className="btn btn-primary"
                                                    style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}
                                                >
                                                    <i className="fas fa-plus"></i> Add
                                                </button>
                                            </div>
                                        </div>
                                    </div>

                                    {customClasses.length > 0 ? (
                                        <div style={{ marginTop: '15px' }}>
                                            <h6 style={{ marginBottom: '8px', color: 'var(--secondary)' }}>Configured Custom Classes:</h6>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                                {customClasses.map((cls) => (
                                                    <div key={cls.id} style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: '8px',
                                                        background: 'white', padding: '6px 12px', borderRadius: '8px',
                                                        border: '1px solid var(--border)', fontSize: '13px'
                                                    }}>
                                                        <span style={{ fontWeight: '600', color: 'var(--primary)' }}>{cls.className}</span>
                                                        <span style={{ fontSize: '11px', color: 'var(--gray)' }}>({LEVEL_DISPLAY_NAMES[cls.level] || cls.level})</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => setCustomClasses(prev => prev.filter(c => c.id !== cls.id))}
                                                            style={{ border: 'none', background: 'transparent', color: '#e74c3c', cursor: 'pointer', padding: '0 4px' }}
                                                            title="Remove Class"
                                                        >
                                                            <i className="fas fa-times"></i>
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ) : (
                                        <p style={{ fontSize: '13px', color: 'var(--gray)', fontStyle: 'italic', margin: 0 }}>
                                            No custom classes added yet. Add classes above to override defaults.
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>

                        <div style={{ marginTop: '25px', padding: '20px', background: '#f8fafc', borderRadius: '12px', border: '1px solid var(--border)' }}>
                            <h4 style={{ marginBottom: '10px', color: 'var(--secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <i className="fas fa-book-open"></i> Subject Structure & Customised Subjects
                            </h4>
                            <p style={{ fontSize: '13px', color: 'var(--gray)', marginBottom: '15px' }}>
                                Toggle to add customised or elective subjects per level in addition to standard KICD subjects.
                            </p>
                            
                            <div className="form-group" style={{ marginBottom: '20px' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontWeight: '600' }}>
                                    <input
                                        type="checkbox"
                                        checked={useCustomSubjects}
                                        onChange={(e) => setUseCustomSubjects(e.target.checked)}
                                        style={{ width: '18px', height: '18px', accentColor: 'var(--primary)' }}
                                    />
                                    Enable Customised Subjects
                                </label>
                            </div>

                            {useCustomSubjects && (
                                <div style={{ borderTop: '1px solid var(--border)', paddingTop: '15px' }}>
                                    <h5 style={{ marginBottom: '10px', color: 'var(--secondary)' }}>Add Custom Subject</h5>
                                    <div className="form-row" style={{ marginBottom: '15px' }}>
                                        <div className="form-group">
                                            <label>Select Level</label>
                                            <select
                                                value={newSubjectLevel}
                                                onChange={(e) => setNewSubjectLevel(e.target.value)}
                                                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'white' }}
                                            >
                                                {availableLevels.map(l => (
                                                    <option key={l.value} value={l.value}>{l.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="form-group">
                                            <label>Subject Name</label>
                                            <div style={{ display: 'flex', gap: '8px' }}>
                                                <input
                                                    type="text"
                                                    value={newSubjectName}
                                                    onChange={(e) => setNewSubjectName(e.target.value)}
                                                    placeholder="e.g. Mandarin, Coding & Robotics"
                                                    style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', flex: 1 }}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const subName = newSubjectName.trim();
                                                        if (!subName) return;
                                                        if (customSubjects.some(s => s.level === newSubjectLevel && s.name.toLowerCase() === subName.toLowerCase())) {
                                                            showNotification('Subject already exists for this level', 'warning');
                                                            return;
                                                        }
                                                        const newEntry = {
                                                            id: Date.now().toString(),
                                                            level: newSubjectLevel,
                                                            name: subName
                                                        };
                                                        setCustomSubjects(prev => [...prev, newEntry]);
                                                        setNewSubjectName('');
                                                        showNotification(`Added custom subject: ${subName}`, 'success');
                                                    }}
                                                    className="btn btn-primary"
                                                    style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}
                                                >
                                                    <i className="fas fa-plus"></i> Add
                                                </button>
                                            </div>
                                        </div>
                                    </div>

                                    {customSubjects.length > 0 ? (
                                        <div style={{ marginTop: '15px' }}>
                                            <h6 style={{ marginBottom: '8px', color: 'var(--secondary)' }}>Configured Custom Subjects:</h6>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                                {customSubjects.map((sub) => (
                                                    <div key={sub.id} style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: '8px',
                                                        background: 'white', padding: '6px 12px', borderRadius: '8px',
                                                        border: '1px solid var(--border)', fontSize: '13px'
                                                    }}>
                                                        <span style={{ fontWeight: '600', color: 'var(--primary)' }}>{sub.name}</span>
                                                        <span style={{ fontSize: '11px', color: 'var(--gray)' }}>({LEVEL_DISPLAY_NAMES[sub.level] || sub.level})</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => setCustomSubjects(prev => prev.filter(s => s.id !== sub.id))}
                                                            style={{ border: 'none', background: 'transparent', color: '#e74c3c', cursor: 'pointer', padding: '0 4px' }}
                                                            title="Remove Subject"
                                                        >
                                                            <i className="fas fa-times"></i>
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ) : (
                                        <p style={{ fontSize: '13px', color: 'var(--gray)', fontStyle: 'italic', margin: 0 }}>
                                            No custom subjects added yet. Add subjects above.
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ----- Tab: Finance ----- */}
                {activeTab === 'finance' && renderFinanceTab()}

                {/* ----- Tab: Admins ----- */}
                {activeTab === 'admins' && (
                    <div className="form-section active">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
                            <h3 style={{ fontSize: 16, color: 'var(--secondary)' }}>School Administrators</h3>
                            <button className="btn btn-primary" onClick={() => document.getElementById('adminModal').classList.add('active')}>
                                <i className="fas fa-user-plus"></i> Add Admin
                            </button>
                        </div>
                        <div className="admin-list">{renderAdmins()}</div>
                    </div>
                )}

                {/* ----- Tab: Settings ----- */}
                {activeTab === 'settings' && (
                    <div className="form-section active">
                        <div className="form-group">
                            <label>Language</label>
                            <select id="language" value={formData.language} onChange={handleInputChange}>
                                <option value="en">English</option>
                                <option value="sw">Swahili</option>
                                <option value="fr">French</option>
                                <option value="es">Spanish</option>
                            </select>
                        </div>
                        <div className="form-group">
                            <label>Time Zone</label>
                            <select id="timezone" value={formData.timezone} onChange={handleInputChange}>
                                <option value="UTC+3">Africa/Nairobi (UTC+3)</option>
                                <option value="UTC+0">UTC+0</option>
                                <option value="UTC+1">UTC+1</option>
                                <option value="UTC+2">UTC+2</option>
                                <option value="UTC+4">UTC+4</option>
                            </select>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Date Format</label>
                                <select id="dateFormat" value={formData.dateFormat} onChange={handleInputChange}>
                                    <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                                    <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                                    <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Time Format</label>
                                <select id="timeFormat" value={formData.timeFormat} onChange={handleInputChange}>
                                    <option value="12h">12-hour (AM/PM)</option>
                                    <option value="24h">24-hour</option>
                                </select>
                            </div>
                        </div>
                        <div className="form-group">
                            <label style={checkRowStyle}>
                                <input type="checkbox" id="enableNotifications" checked={formData.enableNotifications} onChange={handleInputChange} />
                                Enable Email Notifications
                            </label>
                        </div>
                        <div className="form-group">
                            <label style={checkRowStyle}>
                                <input type="checkbox" id="enableSMS" checked={formData.enableSMS} onChange={handleInputChange} />
                                Enable SMS Notifications
                            </label>
                        </div>
                        <div className="form-group">
                            <label style={checkRowStyle}>
                                <input type="checkbox" id="enableBackup" checked={formData.enableBackup} onChange={handleInputChange} />
                                Automatic Data Backup
                            </label>
                        </div>
                    </div>
                )}

                {activeTab !== 'finance' && (
                    <div style={{ marginTop: 30, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
                        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                            {saving ? (
                                <>
                                    <span className="loading-spinner" style={spinnerStyle}></span>
                                    Saving…
                                </>
                            ) : (
                                <>
                                    <i className="fas fa-save"></i> Save Changes
                                </>
                            )}
                        </button>
                    </div>
                )}
            </div>

            {/* Add Admin Modal */}
            <div className="modal-overlay" id="adminModal">
                <div className="modal">
                    <div className="modal-header">
                        <h2>Add Administrator</h2>
                        <button className="modal-close" onClick={() => document.getElementById('adminModal').classList.remove('active')}>
                            <i className="fas fa-times"></i>
                        </button>
                    </div>
                    <form onSubmit={handleAddAdmin}>
                        <div className="form-row">
                            <div className="form-group">
                                <label>First Name <span className="required">*</span></label>
                                <input type="text" name="adminFirstName" required />
                            </div>
                            <div className="form-group">
                                <label>Last Name <span className="required">*</span></label>
                                <input type="text" name="adminLastName" required />
                            </div>
                        </div>
                        <div className="form-group">
                            <label>Email <span className="required">*</span></label>
                            <input type="email" name="adminEmail" required />
                        </div>
                        <div className="form-group">
                            <label>Role <span className="required">*</span></label>
                            <select name="adminRole" required>
                                <option value="admin">Administrator</option>
                                <option value="super-admin">Super Administrator</option>
                                <option value="teacher">Teacher</option>
                                <option value="staff">Staff</option>
                            </select>
                        </div>
                        <div className="form-group">
                            <label>Phone Number</label>
                            <input type="tel" name="adminPhone" />
                        </div>
                        <div className="modal-footer">
                            <button type="button" className="btn btn-outline" onClick={() => document.getElementById('adminModal').classList.remove('active')}>
                                Cancel
                            </button>
                            <button type="submit" className="btn btn-primary">Add Admin</button>
                        </div>
                    </form>
                </div>
            </div>
        </Layout>
    );
}

// ---- Inline style constants ----
const disabledFieldStyle = {
    background: '#f0f0f0',
    color: '#888',
    cursor: 'not-allowed',
    borderColor: '#ddd'
};

const spinnerStyle = {
    width: 20, height: 20,
    border: '2px solid rgba(255,255,255,0.3)',
    borderTopColor: 'white',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite'
};

const checkRowStyle = {
    display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer'
};

const cachedBannerStyle = {
    background: '#d1ecf1', color: '#0c5460', padding: '8px 16px',
    borderRadius: 8, marginBottom: 20, display: 'flex',
    alignItems: 'center', gap: 10, fontSize: 13, border: '1px solid #bee5eb'
};

// ---- Styles (unchanged) ----
const styles = `
    .profile-card { background:white; border-radius:16px; padding:30px; box-shadow:var(--shadow); margin-bottom:30px; max-width:1000px; margin:0 auto; }
    .profile-header { display:flex; align-items:center; gap:30px; margin-bottom:30px; padding:20px; background:var(--light); border-radius:12px; }
    .profile-avatar { width:120px; height:120px; border-radius:50%; background:var(--light); display:flex; align-items:center; justify-content:center; font-size:48px; color:var(--primary); border:3px solid var(--primary); position:relative; flex-shrink:0; overflow:hidden; }
    .profile-avatar img { width:100%; height:100%; border-radius:50%; object-fit:cover; }
    .profile-avatar .upload-btn { position:absolute; bottom:0; right:0; width:36px; height:36px; border-radius:50%; background:var(--primary); color:white; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:14px; transition:all 0.3s; }
    .profile-avatar .upload-btn:hover { background:var(--primary-dark); transform:scale(1.1); }
    .profile-info .school-id { font-size:14px; color:var(--gray); }
    .profile-info .school-status { display:inline-block; padding:4px 16px; border-radius:20px; font-size:13px; font-weight:600; margin-top:8px; }
    .profile-info .school-status.active { background:#d4edda; color:#155724; }
    .profile-info .school-status.inactive { background:#f8d7da; color:#721c24; }
    .profile-info .school-status.pending { background:#fff3cd; color:#856404; }
    .tabs { display:flex; gap:5px; border-bottom:2px solid var(--border); margin-bottom:25px; flex-wrap:wrap; }
    .tab { padding:12px 24px; border:none; background:transparent; color:var(--gray); font-weight:600; cursor:pointer; transition:all 0.3s; font-size:14px; border-bottom:3px solid transparent; margin-bottom:-2px; }
    .tab:hover { color:var(--secondary); }
    .tab.active { color:var(--primary); border-bottom-color:var(--primary); }
    .form-section { display:none; animation:fadeIn 0.3s ease; }
    .form-section.active { display:block; }
    .form-group { margin-bottom:20px; }
    .form-group label { display:block; font-size:14px; font-weight:600; color:var(--secondary); margin-bottom:5px; }
    .form-group label .required { color:var(--danger); }
    .form-group input, .form-group select, .form-group textarea { width:100%; padding:10px 15px; border:2px solid var(--border); border-radius:8px; font-size:14px; transition:all 0.3s; background:white; color:var(--secondary); }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline:none; border-color:var(--primary); }
    .form-row { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
    .form-row-3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:20px; }
    .admin-list { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:20px; margin-top:20px; }
    .admin-card { background:var(--light); border-radius:12px; padding:20px; display:flex; align-items:center; gap:15px; transition:all 0.3s; }
    .admin-card:hover { box-shadow:var(--shadow); }
    .admin-card .admin-avatar { width:50px; height:50px; border-radius:50%; background:var(--primary); color:white; display:flex; align-items:center; justify-content:center; font-weight:600; font-size:20px; flex-shrink:0; }
    .admin-card .admin-info { flex:1; }
    .admin-card .admin-info .admin-name { font-weight:600; color:var(--secondary); }
    .admin-card .admin-info .admin-role { font-size:13px; color:var(--gray); }
    .admin-card .admin-info .admin-email { font-size:12px; color:var(--gray); }
    .admin-card .admin-actions { display:flex; gap:5px; }
    .admin-card .admin-actions button { padding:5px 10px; border:none; border-radius:6px; cursor:pointer; font-size:12px; transition:all 0.3s; }
    .admin-card .admin-actions .edit-admin { background:var(--primary); color:white; }
    .admin-card .admin-actions .remove-admin { background:var(--danger); color:white; }
    .modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:1000; display:none; align-items:center; justify-content:center; padding:20px; backdrop-filter:blur(4px); }
    .modal-overlay.active { display:flex; }
    .modal { background:white; border-radius:16px; max-width:500px; width:100%; max-height:90vh; overflow-y:auto; padding:30px; animation:slideUp 0.3s ease; }
    .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:25px; }
    .modal-header h2 { font-size:22px; color:var(--secondary); }
    .modal-close { width:40px; height:40px; border:none; border-radius:50%; background:var(--light); cursor:pointer; font-size:18px; transition:all 0.3s; }
    .modal-close:hover { background:var(--border); }
    .modal-footer { display:flex; gap:10px; justify-content:flex-end; margin-top:25px; padding-top:20px; border-top:1px solid var(--border); }
    .custom-notification { position:fixed; top:20px; right:20px; padding:15px 20px; border-radius:8px; box-shadow:0 5px 15px rgba(0,0,0,0.2); z-index:10000; display:flex; align-items:center; gap:10px; animation:slideIn 0.3s ease; max-width:400px; color:white; font-size:14px; }
    .finance-settings-header { margin-bottom:25px; }
    .finance-settings-header h3 { display:flex; align-items:center; gap:10px; }
    .fee-info-box { background:#e8f0fe; border-radius:12px; padding:20px; margin:20px 0; border-left:4px solid var(--primary); }
    .fee-info-box h4 { color:var(--primary); margin-bottom:10px; font-size:15px; }
    .fee-info-box ul { list-style:none; padding:0; margin:0; }
    .fee-info-box ul li { padding:6px 0; font-size:14px; color:var(--secondary); display:flex; align-items:center; gap:10px; }
    .fee-info-box ul li i { color:var(--success); width:20px; }
    @keyframes slideIn { from { transform:translateX(100%); opacity:0; } to { transform:translateX(0); opacity:1; } }
    @keyframes slideOut { from { transform:translateX(0); opacity:1; } to { transform:translateX(100%); opacity:0; } }
    @keyframes slideUp { from { transform:translateY(20px); opacity:0; } to { transform:translateY(0); opacity:1; } }
    @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (max-width:768px) {
        .profile-card { padding:20px; }
        .profile-header { flex-direction:column; text-align:center; gap:15px; }
        .form-row, .form-row-3 { grid-template-columns:1fr; }
        .tabs { overflow-x:auto; flex-wrap:nowrap; }
        .tab { white-space:nowrap; padding:10px 16px; font-size:13px; }
        .admin-list { grid-template-columns:1fr; }
    }
    @media (max-width:480px) {
        .profile-avatar { width:100px; height:100px; font-size:36px; }
    }
`;
