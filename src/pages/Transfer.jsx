// src/pages/Transfer.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { db } from '../firebase';

import {
  collection,
  query,
  where,
  getDocs,
  onSnapshot,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  writeBatch,
  orderBy,
  limit,
  arrayUnion,
  serverTimestamp
} from 'firebase/firestore';

import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';


// ============================================================
// TRANSFER CONSTANTS
// ============================================================

const TRANSFER_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  DECLINED: 'declined'
};

const TRANSFER_STAGES = {
  INITIATED: 'initiated',
  RELEASE_REQUESTED: 'release_requested',
  RELEASED: 'released',
  DATA_TRANSFERRED: 'data_transferred',
  ADMITTED: 'admitted',
  COMPLETED: 'completed'
};


// ============================================================
// MAIN COMPONENT
// ============================================================

export default function Transfer() {

  const { currentUser, userData } = useAuth();
  const { isOnline } = useSync();

  // ----------------------------------------------------------
  // General state
  // ----------------------------------------------------------

  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  const [activeTab, setActiveTab] = useState('new');

  const [transfers, setTransfers] = useState([]);
  const [incomingTransfers, setIncomingTransfers] = useState([]);
  const [outgoingTransfers, setOutgoingTransfers] = useState([]);

  // ----------------------------------------------------------
  // School search
  // ----------------------------------------------------------

  const [schoolSearch, setSchoolSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchingSchools, setSearchingSchools] = useState(false);
  const [selectedSchool, setSelectedSchool] = useState(null);

  const schoolSearchTimeout = useRef(null);

  // ----------------------------------------------------------
  // New transfer form
  // ----------------------------------------------------------

  const [admissionNumber, setAdmissionNumber] = useState('');
  const [studentName, setStudentName] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [transferNotes, setTransferNotes] = useState('');

  // ----------------------------------------------------------
  // Modals
  // ----------------------------------------------------------

  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [selectedTransfer, setSelectedTransfer] = useState(null);
  const [declineReason, setDeclineReason] = useState('');

  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [releaseTransfer, setReleaseTransfer] = useState(null);

  const [releaseStudent, setReleaseStudent] = useState(null);
  const [releaseSearching, setReleaseSearching] = useState(false);

  const unsubscribeTransfers = useRef(null);


  // ============================================================
  // LOAD TRANSFERS
  // ============================================================

  useEffect(() => {

    if (!currentUser || !userData?.schoolId) {
      setLoading(false);
      return;
    }

    const schoolId = userData.schoolId;

    const transfersQuery = query(
      collection(db, 'student_transfers'),
      where('schools', 'array-contains', schoolId)
    );

    unsubscribeTransfers.current = onSnapshot(
      transfersQuery,
      (snapshot) => {

        const list = snapshot.docs
          .map(item => ({
            id: item.id,
            ...item.data()
          }))
          .sort((a, b) => {
            const dateA = new Date(a.createdAt || 0).getTime();
            const dateB = new Date(b.createdAt || 0).getTime();

            return dateB - dateA;
          });

        setTransfers(list);

        const incoming = list.filter(
          transfer =>
            transfer.receivingSchoolId === schoolId &&
            transfer.status !== TRANSFER_STATUS.COMPLETED &&
            transfer.status !== TRANSFER_STATUS.DECLINED
        );

        const outgoing = list.filter(
          transfer =>
            transfer.releasingSchoolId === schoolId &&
            transfer.status !== TRANSFER_STATUS.COMPLETED &&
            transfer.status !== TRANSFER_STATUS.DECLINED
        );

        setIncomingTransfers(incoming);
        setOutgoingTransfers(outgoing);

        setLoading(false);
      },
      error => {
        console.error('Error loading transfers:', error);
        setLoading(false);
      }
    );

    return () => {
      if (unsubscribeTransfers.current) {
        unsubscribeTransfers.current();
      }
    };

  }, [currentUser, userData]);


  // ============================================================
  // SCHOOL LIVE SEARCH
  // ============================================================

  useEffect(() => {

    clearTimeout(schoolSearchTimeout.current);

    if (schoolSearch.trim().length < 2) {
      setSearchResults([]);
      setSearchingSchools(false);
      return;
    }

    setSearchingSchools(true);

    schoolSearchTimeout.current = setTimeout(async () => {

      try {

        const searchTerm = schoolSearch.trim();

        const schoolsQuery = query(
          collection(db, 'schools'),
          where('name', '>=', searchTerm),
          where('name', '<=', searchTerm + '\uf8ff'),
          limit(10)
        );

        const snapshot = await getDocs(schoolsQuery);

        const results = snapshot.docs
          .filter(item => item.id !== userData?.schoolId)
          .map(item => ({
            id: item.id,
            ...item.data()
          }));

        setSearchResults(results);

      } catch (error) {

        console.error('School search error:', error);
        setSearchResults([]);

      } finally {

        setSearchingSchools(false);

      }

    }, 300);

    return () => clearTimeout(schoolSearchTimeout.current);

  }, [schoolSearch, userData?.schoolId]);


  // ============================================================
  // SELECT SCHOOL
  // ============================================================

  const handleSchoolSelect = school => {

    setSelectedSchool(school);
    setSchoolSearch(school.name);
    setSearchResults([]);

  };


  // ============================================================
  // RESET NEW TRANSFER FORM
  // ============================================================

  const resetTransferForm = () => {

    setSchoolSearch('');
    setSelectedSchool(null);
    setAdmissionNumber('');
    setStudentName('');
    setTransferReason('');
    setTransferNotes('');
    setSearchResults([]);

  };


  // ============================================================
  // INITIATE TRANSFER REQUEST
  // ============================================================

  const handleInitiateTransfer = async () => {

    if (!isOnline) {
      alert('You must be online to initiate a transfer request.');
      return;
    }

    if (!selectedSchool) {
      alert('Please select the previous school.');
      return;
    }

    if (!admissionNumber.trim()) {
      alert('Please enter the student admission number.');
      return;
    }

    if (!transferReason) {
      alert('Please select a reason for the transfer.');
      return;
    }

    if (!userData?.schoolId) {
      alert('Your school account is not properly configured.');
      return;
    }

    setProcessing(true);

    try {

      const currentSchoolId = userData.schoolId;

      // --------------------------------------------------------
      // Prevent duplicate active requests for same student
      // --------------------------------------------------------

      const existingQuery = query(
        collection(db, 'student_transfers'),
        where('receivingSchoolId', '==', currentSchoolId),
        where('releasingSchoolId', '==', selectedSchool.id),
        where('admissionNumber', '==', admissionNumber.trim())
      );

      const existingSnapshot = await getDocs(existingQuery);

      const activeDuplicate = existingSnapshot.docs.some(item => {

        const data = item.data();

        return (
          data.status !== TRANSFER_STATUS.COMPLETED &&
          data.status !== TRANSFER_STATUS.DECLINED
        );

      });

      if (activeDuplicate) {

        alert(
          'There is already an active transfer request for this admission number.'
        );

        setProcessing(false);
        return;

      }


      // --------------------------------------------------------
      // IMPORTANT:
      //
      // We DO NOT query the previous school's students collection.
      //
      // The previous school will verify the admission number.
      // --------------------------------------------------------

      const now = new Date().toISOString();

      const transferData = {

        // Student identification supplied by receiving school
        admissionNumber: admissionNumber.trim(),

        // Optional name supplied by receiving school
        // This is NOT treated as verified.
        requestedStudentName: studentName.trim(),

        // Schools
        releasingSchoolId: selectedSchool.id,
        releasingSchoolName: selectedSchool.name,

        receivingSchoolId: currentSchoolId,
        receivingSchoolName:
          userData.schoolName || 'Receiving School',

        schools: [
          selectedSchool.id,
          currentSchoolId
        ],

        // Workflow
        status: TRANSFER_STATUS.PENDING,
        stage: TRANSFER_STAGES.RELEASE_REQUESTED,

        // Transfer information
        reason: transferReason,
        notes: transferNotes.trim(),

        // Initiator
        initiatedBy: currentUser.uid,
        initiatedByUser:
          currentUser.displayName ||
          currentUser.email ||
          'School Administrator',

        // Timestamps
        createdAt: now,
        updatedAt: now,

        // History
        history: [
          {
            stage: TRANSFER_STAGES.INITIATED,
            status: TRANSFER_STATUS.PENDING,
            timestamp: now,
            note:
              `Transfer request initiated by ${
                currentUser.displayName ||
                currentUser.email ||
                'school administrator'
              }`,
            user: currentUser.uid
          }
        ]

      };


      const transferRef = await addDoc(
        collection(db, 'student_transfers'),
        transferData
      );


      // --------------------------------------------------------
      // Notification to previous/releasing school
      // --------------------------------------------------------

      await addDoc(collection(db, 'notifications'), {

        schoolId: selectedSchool.id,

        type: 'transfer_request',

        title: 'New Student Transfer Request',

        message:
          `A transfer request has been received for admission number ` +
          `${admissionNumber.trim()} from ` +
          `${userData.schoolName || 'another school'}.`,

        transferId: transferRef.id,

        read: false,

        createdAt: now,

        link: '/transfer'

      });


      alert(
        'Transfer request sent successfully. The previous school must verify and release the student.'
      );

      resetTransferForm();

      setActiveTab('outgoing');

    } catch (error) {

      console.error('Error initiating transfer:', error);

      alert(
        'Failed to initiate transfer: ' +
        (error.message || 'Unknown error')
      );

    } finally {

      setProcessing(false);

    }

  };


  // ============================================================
  // SOURCE SCHOOL: OPEN RELEASE VERIFICATION
  // ============================================================

  const openReleaseModal = transfer => {

    setReleaseTransfer(transfer);
    setReleaseStudent(null);

    setReleaseSearching(false);

    setShowReleaseModal(true);

  };


  // ============================================================
  // SOURCE SCHOOL: VERIFY STUDENT
  // ============================================================

  const verifyStudentForRelease = async () => {

    if (!releaseTransfer) return;

    if (!releaseTransfer.admissionNumber) {
      alert('No admission number was supplied in this transfer request.');
      return;
    }

    setReleaseSearching(true);

    try {

      const studentsQuery = query(
        collection(db, 'students'),
        where('schoolId', '==', userData.schoolId),
        where('studentId', '==', releaseTransfer.admissionNumber),
        limit(1)
      );

      const snapshot = await getDocs(studentsQuery);

      if (snapshot.empty) {

        alert(
          `No student with admission number "${releaseTransfer.admissionNumber}" was found in your school.`
        );

        setReleaseStudent(null);
        return;

      }

      const studentDoc = snapshot.docs[0];

      setReleaseStudent({
        id: studentDoc.id,
        ...studentDoc.data()
      });

    } catch (error) {

      console.error('Student verification error:', error);

      alert(
        'Unable to verify student: ' +
        (error.message || 'Unknown error')
      );

    } finally {

      setReleaseSearching(false);

    }

  };


  // ============================================================
  // SOURCE SCHOOL: RELEASE STUDENT
  // ============================================================

  const handleReleaseStudent = async () => {

    if (!releaseTransfer || !releaseStudent) {
      alert('Please verify the student before releasing.');
      return;
    }

    if (!isOnline) {
      alert('You must be online to release a student.');
      return;
    }

    const confirmed = window.confirm(
      `Release ${releaseStudent.firstName} ${releaseStudent.lastName}?\n\n` +
      `Admission Number: ${releaseStudent.studentId}\n\n` +
      `The student's academic information will be securely packaged ` +
      `for the receiving school.`
    );

    if (!confirmed) return;

    setProcessing(true);

    try {

      const transferRef = doc(
        db,
        'student_transfers',
        releaseTransfer.id
      );

      // --------------------------------------------------------
      // Get student's academic scores
      // --------------------------------------------------------

      const scoresQuery = query(
        collection(db, 'student_scores'),
        where('studentId', '==', releaseStudent.id),
        where('schoolId', '==', userData.schoolId)
      );

      const scoresSnapshot = await getDocs(scoresQuery);

      const scores = scoresSnapshot.docs.map(scoreDoc => ({
        id: scoreDoc.id,
        ...scoreDoc.data()
      }));


      // --------------------------------------------------------
      // Build secure transfer package
      // --------------------------------------------------------

      const now = new Date().toISOString();

      const transferPackage = {

        transferId: releaseTransfer.id,

        student: {
          id: releaseStudent.id,
          ...releaseStudent
        },

        scores,

        releasingSchoolId:
          releaseTransfer.releasingSchoolId,

        releasingSchoolName:
          releaseTransfer.releasingSchoolName,

        receivingSchoolId:
          releaseTransfer.receivingSchoolId,

        receivingSchoolName:
          releaseTransfer.receivingSchoolName,

        transferredAt: now

      };


      // --------------------------------------------------------
      // Firestore batch
      //
      // Package creation + transfer update + student status
      // are committed together.
      // --------------------------------------------------------

      const batch = writeBatch(db);

      const packageRef = doc(
        db,
        'transfer_packages',
        releaseTransfer.id
      );

      batch.set(packageRef, transferPackage);


      batch.update(transferRef, {

        status: TRANSFER_STATUS.IN_PROGRESS,

        stage: TRANSFER_STAGES.DATA_TRANSFERRED,

        verifiedStudentId: releaseStudent.id,

        verifiedStudentName:
          `${releaseStudent.firstName || ''} ${releaseStudent.lastName || ''}`.trim(),

        releasedAt: now,

        releasedBy: currentUser.uid,

        releasedByUser:
          currentUser.displayName ||
          currentUser.email ||
          'School Administrator',

        updatedAt: now,

        history: arrayUnion({

          stage: TRANSFER_STAGES.DATA_TRANSFERRED,

          status: TRANSFER_STATUS.IN_PROGRESS,

          timestamp: now,

          note:
            `Student verified and academic data released by ${
              currentUser.displayName ||
              currentUser.email ||
              'school administrator'
            }`,

          user: currentUser.uid

        })

      });


      // --------------------------------------------------------
      // Mark original student as transferred
      //
      // We do NOT delete the original record.
      // --------------------------------------------------------

      const studentRef = doc(
        db,
        'students',
        releaseStudent.id
      );

      batch.update(studentRef, {

        transferStatus: 'released',

        activeTransferId: releaseTransfer.id,

        transferReleasedAt: now,

        updatedAt: now

      });


      await batch.commit();


      // --------------------------------------------------------
      // Notify receiving school
      // --------------------------------------------------------

      await addDoc(collection(db, 'notifications'), {

        schoolId:
          releaseTransfer.receivingSchoolId,

        type: 'transfer_data_ready',

        title: 'Student Transfer Ready',

        message:
          `Transfer data for ${releaseStudent.firstName} ` +
          `${releaseStudent.lastName} is ready for admission.`,

        transferId: releaseTransfer.id,

        read: false,

        createdAt: now,

        link: '/transfer'

      });


      setShowReleaseModal(false);
      setReleaseTransfer(null);
      setReleaseStudent(null);

      alert(
        'Student verified and released successfully. The receiving school can now admit the student.'
      );

    } catch (error) {

      console.error('Error releasing student:', error);

      alert(
        'Failed to release student: ' +
        (error.message || 'Unknown error')
      );

    } finally {

      setProcessing(false);

    }

  };


  // ============================================================
  // RECEIVING SCHOOL: ADMIT STUDENT
  // ============================================================

  const handleAdmitStudent = async transfer => {

    if (!isOnline) {
      alert('You must be online to admit a transferred student.');
      return;
    }

    const confirmed = window.confirm(
      `Admit ${transfer.verifiedStudentName || transfer.requestedStudentName || transfer.admissionNumber}?\n\n` +
      `The student will be created in your school's student records.`
    );

    if (!confirmed) return;

    setProcessing(true);

    try {

      // --------------------------------------------------------
      // Get transfer package
      // --------------------------------------------------------

      const packageRef = doc(
        db,
        'transfer_packages',
        transfer.id
      );

      const packageSnapshot = await getDoc(packageRef);

      if (!packageSnapshot.exists()) {

        alert(
          'Transfer data could not be found. The previous school may not have released the student yet.'
        );

        return;

      }

      const transferPackage = packageSnapshot.data();

      const originalStudent =
        transferPackage.student;

      if (!originalStudent) {

        alert('Transfer package does not contain student information.');

        return;

      }


      // --------------------------------------------------------
      // Prevent duplicate admission
      // --------------------------------------------------------

      const duplicateQuery = query(
        collection(db, 'students'),
        where('schoolId', '==', userData.schoolId),
        where('studentId', '==', transfer.admissionNumber),
        limit(1)
      );

      const duplicateSnapshot =
        await getDocs(duplicateQuery);

      if (!duplicateSnapshot.empty) {

        alert(
          'A student with this admission number already exists in your school.'
        );

        return;

      }


      const now = new Date().toISOString();


      // --------------------------------------------------------
      // Create new student record
      // --------------------------------------------------------

      const newStudentData = {

        // Basic student information
        firstName: originalStudent.firstName || '',
        lastName: originalStudent.lastName || '',
        otherNames: originalStudent.otherNames || '',

        studentId:
          originalStudent.studentId ||
          transfer.admissionNumber,

        email: originalStudent.email || '',
        phone: originalStudent.phone || '',

        // Academic information
        level: originalStudent.level || '',
        class: originalStudent.class || '',

        admissionYear:
          new Date().getFullYear().toString(),

        // New school
        schoolId: userData.schoolId,

        schoolName:
          userData.schoolName || '',

        // Transfer information
        transferId: transfer.id,

        transferredFrom:
          transfer.releasingSchoolId,

        transferredFromName:
          transfer.releasingSchoolName,

        transferredAt: now,

        transferAdmissionDate: now,

        isTransferredStudent: true,

        transferStatus: 'completed',

        // Timestamps
        createdAt: now,
        updatedAt: now

      };


      // --------------------------------------------------------
      // Create student + scores + transfer update atomically
      // --------------------------------------------------------

      const batch = writeBatch(db);

      const newStudentRef =
        doc(collection(db, 'students'));

      batch.set(
        newStudentRef,
        newStudentData
      );


      // --------------------------------------------------------
      // Copy academic scores
      // --------------------------------------------------------

      const scores =
        transferPackage.scores || [];

      scores.forEach(score => {

        const newScoreRef =
          doc(collection(db, 'student_scores'));

        const newScore = {
          ...score
        };

        delete newScore.id;

        newScore.studentId =
          newStudentRef.id;

        newScore.schoolId =
          userData.schoolId;

        newScore.transferredFrom =
          transfer.releasingSchoolId;

        newScore.transferId =
          transfer.id;

        newScore.transferredAt =
          now;

        batch.set(
          newScoreRef,
          newScore
        );

      });


      // --------------------------------------------------------
      // Complete transfer
      // --------------------------------------------------------

      const transferRef = doc(
        db,
        'student_transfers',
        transfer.id
      );

      batch.update(
        transferRef,
        {

          status:
            TRANSFER_STATUS.COMPLETED,

          stage:
            TRANSFER_STAGES.COMPLETED,

          admittedAt: now,

          admittedBy:
            currentUser.uid,

          admittedByUser:
            currentUser.displayName ||
            currentUser.email ||
            'School Administrator',

          newStudentId:
            newStudentRef.id,

          updatedAt: now,

          history: arrayUnion({

            stage:
              TRANSFER_STAGES.COMPLETED,

            status:
              TRANSFER_STATUS.COMPLETED,

            timestamp: now,

            note:
              `Student admitted by ${
                currentUser.displayName ||
                currentUser.email ||
                'school administrator'
              }`,

            user:
              currentUser.uid

          })

        }
      );


      await batch.commit();


      // --------------------------------------------------------
      // Delete package AFTER successful admission
      // --------------------------------------------------------

      await deleteDoc(packageRef);


      // --------------------------------------------------------
      // Notify releasing school
      // --------------------------------------------------------

      await addDoc(
        collection(db, 'notifications'),
        {

          schoolId:
            transfer.releasingSchoolId,

          type:
            'transfer_completed',

          title:
            'Student Transfer Completed',

          message:
            `${transfer.verifiedStudentName || transfer.requestedStudentName || transfer.admissionNumber} ` +
            `has been admitted by ${transfer.receivingSchoolName}.`,

          transferId:
            transfer.id,

          read: false,

          createdAt: now,

          link: '/transfer'

        }
      );


      alert(
        'Student admitted successfully. Academic records have been transferred.'
      );

    } catch (error) {

      console.error('Error admitting student:', error);

      alert(
        'Failed to admit student: ' +
        (error.message || 'Unknown error')
      );

    } finally {

      setProcessing(false);

    }

  };


  // ============================================================
  // DECLINE TRANSFER
  // ============================================================

  const handleDeclineTransfer = async () => {

    if (!selectedTransfer) return;

    if (!declineReason.trim()) {

      alert(
        'Please provide a reason for declining the transfer.'
      );

      return;

    }

    setProcessing(true);

    try {

      const now = new Date().toISOString();

      const transferRef = doc(
        db,
        'student_transfers',
        selectedTransfer.id
      );

      await updateDoc(
        transferRef,
        {

          status:
            TRANSFER_STATUS.DECLINED,

          stage:
            selectedTransfer.stage,

          declinedAt: now,

          declinedBy:
            currentUser.uid,

          declinedByUser:
            currentUser.displayName ||
            currentUser.email ||
            'School Administrator',

          declineReason:
            declineReason.trim(),

          updatedAt: now,

          history: arrayUnion({

            stage:
              selectedTransfer.stage,

            status:
              TRANSFER_STATUS.DECLINED,

            timestamp: now,

            note:
              `Transfer declined: ${declineReason.trim()}`,

            user:
              currentUser.uid

          })

        }
      );


      // Notify receiving school

      await addDoc(
        collection(db, 'notifications'),
        {

          schoolId:
            selectedTransfer.receivingSchoolId,

          type:
            'transfer_declined',

          title:
            'Transfer Request Declined',

          message:
            `Transfer request for admission number ` +
            `${selectedTransfer.admissionNumber} was declined. ` +
            `Reason: ${declineReason.trim()}`,

          transferId:
            selectedTransfer.id,

          read: false,

          createdAt: now,

          link: '/transfer'

        }
      );


      setShowDeclineModal(false);
      setSelectedTransfer(null);
      setDeclineReason('');

      alert(
        'Transfer request declined successfully.'
      );

    } catch (error) {

      console.error('Error declining transfer:', error);

      alert(
        'Failed to decline transfer: ' +
        (error.message || 'Unknown error')
      );

    } finally {

      setProcessing(false);

    }

  };


  // ============================================================
  // STATUS DISPLAY
  // ============================================================

  const getStatusColor = transfer => {

    if (
      transfer.status === TRANSFER_STATUS.COMPLETED
    ) {
      return 'var(--success)';
    }

    if (
      transfer.status === TRANSFER_STATUS.DECLINED
    ) {
      return 'var(--danger)';
    }

    if (
      transfer.status === TRANSFER_STATUS.IN_PROGRESS
    ) {
      return 'var(--info)';
    }

    return 'var(--warning)';

  };


  const getStageDisplay = transfer => {

    const stages = {

      [TRANSFER_STAGES.INITIATED]:
        '⏳ Request Initiated',

      [TRANSFER_STAGES.RELEASE_REQUESTED]:
        '📤 Awaiting Previous School',

      [TRANSFER_STAGES.RELEASED]:
        '✅ Student Released',

      [TRANSFER_STAGES.DATA_TRANSFERRED]:
        '📦 Data Ready',

      [TRANSFER_STAGES.ADMITTED]:
        '🏫 Student Admitted',

      [TRANSFER_STAGES.COMPLETED]:
        '🎉 Completed'

    };

    return (
      stages[transfer.stage] ||
      transfer.stage ||
      'Unknown'
    );

  };


  // ============================================================
  // TRANSFER CARD
  // ============================================================

  const renderTransferCard = (
    transfer,
    type
  ) => {

    const isIncoming =
      type === 'incoming';

    const isOutgoing =
      type === 'outgoing';

    const isHistory =
      type === 'history';

    const isPending =
      transfer.status ===
      TRANSFER_STATUS.PENDING;

    const isDataReady =
      transfer.stage ===
      TRANSFER_STAGES.DATA_TRANSFERRED;

    const isCompleted =
      transfer.status ===
      TRANSFER_STATUS.COMPLETED;

    const isDeclined =
      transfer.status ===
      TRANSFER_STATUS.DECLINED;

    const statusColor =
      getStatusColor(transfer);


    return (

      <div
        key={transfer.id}
        className="transfer-card"
        style={{
          background: 'white',
          borderRadius: '12px',
          padding: '20px',
          marginBottom: '15px',
          boxShadow:
            '0 2px 8px rgba(0,0,0,0.08)',
          borderLeft:
            `4px solid ${statusColor}`
        }}
      >

        {/* ----------------------------------------------------
             Header
        ----------------------------------------------------- */}

        <div
          className="transfer-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: '10px'
          }}
        >

          <div>

            <h3
              style={{
                margin: 0,
                fontSize: '16px',
                fontWeight: '600'
              }}
            >
              {transfer.verifiedStudentName ||
               transfer.requestedStudentName ||
               `Admission ${transfer.admissionNumber}`}
            </h3>

            <div
              style={{
                fontSize: '13px',
                color: 'var(--gray)',
                marginTop: '4px'
              }}
            >
              Admission:
              {' '}
              <strong>
                {transfer.admissionNumber}
              </strong>
            </div>

          </div>


          <div
            style={{
              textAlign: 'right'
            }}
          >

            <span
              style={{
                display: 'inline-block',
                padding: '4px 12px',
                borderRadius: '20px',
                fontSize: '12px',
                fontWeight: '600',
                background:
                  `${statusColor}20`,
                color:
                  statusColor
              }}
            >
              {transfer.status
                ?.replace(/_/g, ' ')
                .replace(/\b\w/g, char =>
                  char.toUpperCase()
                )}
            </span>

            <div
              style={{
                fontSize: '12px',
                color: 'var(--gray)',
                marginTop: '5px'
              }}
            >
              {getStageDisplay(transfer)}
            </div>

          </div>

        </div>


        {/* ----------------------------------------------------
             Transfer information
        ----------------------------------------------------- */}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              '1fr 1fr',
            gap: '10px',
            marginTop: '15px',
            padding: '12px',
            background: 'var(--light)',
            borderRadius: '8px',
            fontSize: '13px'
          }}
        >

          <div>
            <strong>From:</strong>
            {' '}
            {transfer.releasingSchoolName}
          </div>

          <div>
            <strong>To:</strong>
            {' '}
            {transfer.receivingSchoolName}
          </div>

          <div>
            <strong>Reason:</strong>
            {' '}
            {transfer.reason || 'N/A'}
          </div>

          <div>
            <strong>Requested:</strong>
            {' '}
            {transfer.createdAt
              ? new Date(
                  transfer.createdAt
                ).toLocaleDateString()
              : 'N/A'}
          </div>

        </div>


        {/* ----------------------------------------------------
             Notes
        ----------------------------------------------------- */}

        {transfer.notes && (

          <div
            style={{
              marginTop: '10px',
              padding: '10px',
              background: '#f8f9fa',
              borderRadius: '8px',
              fontSize: '13px'
            }}
          >

            <strong>
              Notes:
            </strong>

            {' '}

            {transfer.notes}

          </div>

        )}


        {/* ----------------------------------------------------
             Decline reason
        ----------------------------------------------------- */}

        {transfer.declineReason && (

          <div
            style={{
              marginTop: '10px',
              padding: '10px',
              background: '#fff3cd',
              borderRadius: '8px',
              borderLeft:
                '3px solid var(--warning)',
              fontSize: '13px'
            }}
          >

            <strong>
              Decline Reason:
            </strong>

            {' '}

            {transfer.declineReason}

          </div>

        )}


        {/* ----------------------------------------------------
             Actions
        ----------------------------------------------------- */}

        <div
          style={{
            marginTop: '15px',
            display: 'flex',
            gap: '10px',
            flexWrap: 'wrap'
          }}
        >

          {/* ==================================================
               SOURCE SCHOOL
               Verify and release
             ================================================== */}

          {isIncoming && isPending && (

            <>

              <button
                className="btn btn-success"
                onClick={() =>
                  openReleaseModal(transfer)
                }
                disabled={processing}
              >
                <i className="fas fa-user-check"></i>
                Verify & Release
              </button>


              <button
                className="btn btn-danger"
                onClick={() => {

                  setSelectedTransfer(
                    transfer
                  );

                  setShowDeclineModal(true);

                }}
                disabled={processing}
              >
                <i className="fas fa-times"></i>
                Decline
              </button>

            </>

          )}


          {/* ==================================================
               RECEIVING SCHOOL
               Admit released student
             ================================================== */}

          {isIncoming && isDataReady && (

            <button
              className="btn btn-primary"
              onClick={() =>
                handleAdmitStudent(transfer)
              }
              disabled={processing}
            >

              <i className="fas fa-user-plus"></i>

              Admit Student

            </button>

          )}


          {/* ==================================================
               OUTGOING
             ================================================== */}

          {isOutgoing &&
           transfer.stage ===
             TRANSFER_STAGES.RELEASE_REQUESTED && (

            <span
              style={{
                color: 'var(--warning)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px'
              }}
            >

              <i className="fas fa-clock"></i>

              Awaiting verification and release
              from previous school

            </span>

          )}


          {isOutgoing &&
           isDataReady && (

            <span
              style={{
                color: 'var(--info)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px'
              }}
            >

              <i className="fas fa-box"></i>

              Data has been released.
              Awaiting admission.

            </span>

          )}


          {isCompleted && (

            <span
              style={{
                color: 'var(--success)',
                fontWeight: '600',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px'
              }}
            >

              <i className="fas fa-check-circle"></i>

              Transfer Completed

            </span>

          )}


          {isDeclined && (

            <span
              style={{
                color: 'var(--danger)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px'
              }}
            >

              <i className="fas fa-times-circle"></i>

              Transfer Declined

            </span>

          )}


          {/* --------------------------------------------------
               History
          --------------------------------------------------- */}

          <button
            className="btn btn-outline"
            onClick={() => {

              const history =
                transfer.history || [];

              const message =
                history.length > 0
                  ? history.map(item =>
                      `${new Date(
                        item.timestamp
                      ).toLocaleString()} - ${item.note}`
                    ).join('\n')
                  : 'No history available.';

              alert(
                `Transfer History\n\n${message}`
              );

            }}
          >

            <i className="fas fa-history"></i>

            View History

          </button>

        </div>

      </div>

    );

  };


  // ============================================================
  // LOADING
  // ============================================================

  if (loading) {

    return (
      <LoadingSpinner
        fullScreen
        text="Loading transfers..."
      />
    );

  }


  // ============================================================
  // RENDER
  // ============================================================

  return (

    <Layout title="Student Transfer Management">

      <style>{`

        .transfer-container {
          max-width: 1200px;
          margin: 0 auto;
        }

        .transfer-tabs {
          display: flex;
          gap: 5px;
          border-bottom: 2px solid var(--border);
          margin-bottom: 25px;
          flex-wrap: wrap;
        }

        .transfer-tab {
          padding: 12px 24px;
          border: none;
          background: transparent;
          color: var(--gray);
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s;
          font-size: 14px;
          border-bottom: 3px solid transparent;
          margin-bottom: -2px;
        }

        .transfer-tab:hover {
          color: var(--secondary);
        }

        .transfer-tab.active {
          color: var(--primary);
          border-bottom-color: var(--primary);
        }

        .transfer-tab .badge {
          display: inline-block;
          padding: 1px 8px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          margin-left: 6px;
        }

        .badge.incoming {
          background: #d1ecf1;
          color: #0c5460;
        }

        .badge.outgoing {
          background: #fff3cd;
          color: #856404;
        }

        .transfer-form-section {
          background: white;
          border-radius: 12px;
          padding: 25px;
          box-shadow: var(--shadow);
          margin-bottom: 25px;
        }

        .transfer-form-section h2 {
          font-size: 18px;
          color: var(--secondary);
          margin-bottom: 20px;
        }

        .form-group {
          margin-bottom: 20px;
        }

        .form-group label {
          display: block;
          font-size: 14px;
          font-weight: 600;
          color: var(--secondary);
          margin-bottom: 6px;
        }

        .required {
          color: var(--danger);
        }

        .form-group input,
        .form-group select,
        .form-group textarea {
          width: 100%;
          padding: 10px 15px;
          border: 2px solid var(--border);
          border-radius: 8px;
          font-size: 14px;
          transition: all 0.3s;
          background: white;
          color: var(--secondary);
          box-sizing: border-box;
        }

        .form-group input:focus,
        .form-group select:focus,
        .form-group textarea:focus {
          outline: none;
          border-color: var(--primary);
        }

        .search-results {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          background: white;
          border: 2px solid var(--border);
          border-radius: 8px;
          max-height: 220px;
          overflow-y: auto;
          z-index: 100;
          margin-top: 4px;
          box-shadow: var(--shadow-lg);
        }

        .search-result-item {
          padding: 12px 15px;
          cursor: pointer;
          transition: all 0.2s;
          border-bottom: 1px solid var(--border);
        }

        .search-result-item:hover {
          background: var(--light);
        }

        .school-name {
          font-weight: 600;
          color: var(--secondary);
        }

        .school-details {
          font-size: 12px;
          color: var(--gray);
          margin-top: 3px;
        }

        .selected-info {
          background: var(--light);
          border-radius: 8px;
          padding: 15px;
          margin: 15px 0;
        }

        .selected-info .label {
          font-size: 12px;
          color: var(--gray);
          font-weight: 500;
        }

        .selected-info .value {
          font-size: 15px;
          font-weight: 600;
          color: var(--secondary);
          margin-top: 3px;
        }

        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
        }

        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-size: 14px;
        }

        .btn-primary {
          background: var(--primary);
          color: white;
        }

        .btn-primary:hover {
          background: var(--primary-dark);
          transform: translateY(-1px);
        }

        .btn-success {
          background: var(--success);
          color: white;
        }

        .btn-success:hover {
          opacity: 0.9;
        }

        .btn-danger {
          background: var(--danger);
          color: white;
        }

        .btn-danger:hover {
          opacity: 0.9;
        }

        .btn-outline {
          background: transparent;
          border: 2px solid var(--border);
          color: var(--secondary);
        }

        .btn-outline:hover {
          border-color: var(--primary);
          color: var(--primary);
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none !important;
        }

        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          z-index: 1000;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 20px;
          backdrop-filter: blur(4px);
        }

        .modal-overlay.active {
          display: flex;
        }

        .modal {
          background: white;
          border-radius: 16px;
          max-width: 550px;
          width: 100%;
          max-height: 90vh;
          overflow-y: auto;
          padding: 30px;
          box-sizing: border-box;
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .modal-header h2 {
          font-size: 21px;
          color: var(--secondary);
          margin: 0;
        }

        .modal-close {
          width: 38px;
          height: 38px;
          border: none;
          border-radius: 50%;
          background: var(--light);
          cursor: pointer;
          font-size: 18px;
        }

        .modal-footer {
          display: flex;
          gap: 10px;
          justify-content: flex-end;
          margin-top: 25px;
          padding-top: 20px;
          border-top: 1px solid var(--border);
        }

        .verification-box {
          padding: 15px;
          border-radius: 10px;
          background: var(--light);
          margin: 15px 0;
        }

        .student-verified {
          background: #e8f5e9;
          border: 1px solid #c8e6c9;
        }

        .student-notice {
          padding: 12px;
          background: #fff3cd;
          border-radius: 8px;
          color: #856404;
          font-size: 13px;
          margin-top: 15px;
        }

        @media (max-width: 768px) {

          .form-row {
            grid-template-columns: 1fr;
          }

          .transfer-tabs {
            flex-wrap: nowrap;
            overflow-x: auto;
          }

          .transfer-tab {
            white-space: nowrap;
            padding: 10px 16px;
            font-size: 13px;
          }

          .transfer-card {
            padding: 15px !important;
          }

          .transfer-header {
            flex-direction: column;
          }

        }

      `}</style>


      <div className="transfer-container">

        {/* ====================================================
             TABS
        ===================================================== */}

        <div className="transfer-tabs">

          <button
            className={
              `transfer-tab ${
                activeTab === 'new'
                  ? 'active'
                  : ''
              }`
            }
            onClick={() =>
              setActiveTab('new')
            }
          >

            <i className="fas fa-plus"></i>

            {' '}

            New Transfer

          </button>


          <button
            className={
              `transfer-tab ${
                activeTab === 'incoming'
                  ? 'active'
                  : ''
              }`
            }
            onClick={() =>
              setActiveTab('incoming')
            }
          >

            <i className="fas fa-arrow-down"></i>

            {' '}

            Requests

            {incomingTransfers.length > 0 && (

              <span className="badge incoming">
                {incomingTransfers.length}
              </span>

            )}

          </button>


          <button
            className={
              `transfer-tab ${
                activeTab === 'outgoing'
                  ? 'active'
                  : ''
              }`
            }
            onClick={() =>
              setActiveTab('outgoing')
            }
          >

            <i className="fas fa-arrow-up"></i>

            {' '}

            My Requests

            {outgoingTransfers.length > 0 && (

              <span className="badge outgoing">
                {outgoingTransfers.length}
              </span>

            )}

          </button>


          <button
            className={
              `transfer-tab ${
                activeTab === 'history'
                  ? 'active'
                  : ''
              }`
            }
            onClick={() =>
              setActiveTab('history')
            }
          >

            <i className="fas fa-history"></i>

            {' '}

            History

          </button>

        </div>


        {/* ====================================================
             NEW TRANSFER
        ===================================================== */}

        {activeTab === 'new' && (

          <div className="transfer-form-section">

            <h2>
              <i className="fas fa-exchange-alt"></i>

              {' '}

              Request Student Transfer
            </h2>


            <p
              style={{
                color: 'var(--gray)',
                fontSize: '14px',
                marginBottom: '25px'
              }}
            >

              Find the student's previous school and
              submit a transfer request. The previous
              school will verify the admission number
              before releasing the student's records.

            </p>


            {/* ------------------------------------------------
                 PREVIOUS SCHOOL
            ------------------------------------------------- */}

            <div
              className="form-group"
              style={{
                position: 'relative'
              }}
            >

              <label>
                Previous School
                {' '}
                <span className="required">
                  *
                </span>
              </label>


              <input
                type="text"
                placeholder="Type school name to search..."
                value={schoolSearch}
                onChange={event => {

                  setSchoolSearch(
                    event.target.value
                  );

                  if (
                    selectedSchool &&
                    event.target.value !==
                      selectedSchool.name
                  ) {
                    setSelectedSchool(null);
                  }

                }}
                disabled={processing}
                autoComplete="off"
              />


              {searchingSchools && (

                <div
                  style={{
                    position: 'absolute',
                    right: '12px',
                    top: '39px'
                  }}
                >

                  <i className="fas fa-spinner fa-spin"></i>

                </div>

              )}


              {searchResults.length > 0 && (

                <div className="search-results">

                  {searchResults.map(school => (

                    <div
                      key={school.id}
                      className="search-result-item"
                      onClick={() =>
                        handleSchoolSelect(school)
                      }
                    >

                      <div className="school-name">
                        {school.name}
                      </div>

                      <div className="school-details">

                        {school.city || ''}

                        {school.country
                          ? ` • ${school.country}`
                          : ''}

                      </div>

                    </div>

                  ))}

                </div>

              )}

            </div>


            {selectedSchool && (

              <div className="selected-info">

                <div className="label">
                  Previous School Selected
                </div>

                <div className="value">

                  <i className="fas fa-school"></i>

                  {' '}

                  {selectedSchool.name}

                </div>

                <div
                  style={{
                    fontSize: '13px',
                    color: 'var(--gray)',
                    marginTop: '5px'
                  }}
                >

                  {selectedSchool.city || ''}

                  {selectedSchool.country
                    ? ` • ${selectedSchool.country}`
                    : ''}

                </div>

              </div>

            )}


            {/* ------------------------------------------------
                 ADMISSION NUMBER
            ------------------------------------------------- */}

            <div className="form-group">

              <label>
                Student Admission Number
                {' '}
                <span className="required">
                  *
                </span>
              </label>

              <input
                type="text"
                placeholder="Enter admission number"
                value={admissionNumber}
                onChange={event =>
                  setAdmissionNumber(
                    event.target.value
                  )
                }
                disabled={
                  !selectedSchool ||
                  processing
                }
              />

              <div
                className="student-notice"
              >

                <i className="fas fa-shield-alt"></i>

                {' '}

                The receiving school does not directly
                access the previous school's student
                database. The previous school will verify
                this admission number.

              </div>

            </div>


            {/* ------------------------------------------------
                 OPTIONAL STUDENT NAME
            ------------------------------------------------- */}

            <div className="form-group">

              <label>
                Student Name
                <span
                  style={{
                    fontWeight: 'normal',
                    color: 'var(--gray)'
                  }}
                >
                  {' '}
                  (optional)
                </span>
              </label>

              <input
                type="text"
                placeholder="If known, enter student's name"
                value={studentName}
                onChange={event =>
                  setStudentName(
                    event.target.value
                  )
                }
                disabled={
                  !selectedSchool ||
                  processing
                }
              />

            </div>


            {/* ------------------------------------------------
                 REASON + NOTES
            ------------------------------------------------- */}

            <div className="form-row">

              <div className="form-group">

                <label>
                  Reason for Transfer
                  {' '}
                  <span className="required">
                    *
                  </span>
                </label>

                <select
                  value={transferReason}
                  onChange={event =>
                    setTransferReason(
                      event.target.value
                    )
                  }
                  disabled={
                    !selectedSchool ||
                    processing
                  }
                >

                  <option value="">
                    Select reason...
                  </option>

                  <option value="parental_relocation">
                    Parental Relocation
                  </option>

                  <option value="academic_transition">
                    Academic Transition
                  </option>

                  <option value="family_move">
                    Family Move
                  </option>

                  <option value="financial">
                    Financial Reasons
                  </option>

                  <option value="sports">
                    Sports/Special Program
                  </option>

                  <option value="other">
                    Other
                  </option>

                </select>

              </div>


              <div className="form-group">

                <label>
                  Transfer Notes
                </label>

                <textarea
                  rows="3"
                  placeholder="Additional information..."
                  value={transferNotes}
                  onChange={event =>
                    setTransferNotes(
                      event.target.value
                    )
                  }
                  disabled={
                    !selectedSchool ||
                    processing
                  }
                />

              </div>

            </div>


            {/* ------------------------------------------------
                 SUBMIT
            ------------------------------------------------- */}

            <button
              className="btn btn-primary"
              style={{
                width: '100%',
                padding: '14px'
              }}
              onClick={
                handleInitiateTransfer
              }
              disabled={
                processing ||
                !isOnline ||
                !selectedSchool ||
                !admissionNumber.trim() ||
                !transferReason
              }
            >

              {processing ? (

                <>

                  <i className="fas fa-spinner fa-spin"></i>

                  Sending Request...

                </>

              ) : (

                <>

                  <i className="fas fa-paper-plane"></i>

                  Send Transfer Request

                </>

              )}

            </button>

          </div>

        )}


        {/* ====================================================
             INCOMING REQUESTS
        ===================================================== */}

        {activeTab === 'incoming' && (

          <div>

            <h3
              style={{
                marginBottom: '15px'
              }}
            >

              <i className="fas fa-arrow-down"></i>

              {' '}

              Transfer Requests

            </h3>


            {incomingTransfers.length === 0 ? (

              <div
                style={{
                  textAlign: 'center',
                  padding: '50px'
                }}
              >

                <i
                  className="fas fa-inbox"
                  style={{
                    fontSize: '48px',
                    color: 'var(--border)'
                  }}
                ></i>

                <h3>
                  No Transfer Requests
                </h3>

                <p
                  style={{
                    color: 'var(--gray)'
                  }}
                >
                  There are no pending transfer
                  requests for your school.
                </p>

              </div>

            ) : (

              incomingTransfers.map(
                transfer =>
                  renderTransferCard(
                    transfer,
                    'incoming'
                  )
              )

            )}

          </div>

        )}


        {/* ====================================================
             OUTGOING
        ===================================================== */}

        {activeTab === 'outgoing' && (

          <div>

            <h3
              style={{
                marginBottom: '15px'
              }}
            >

              <i className="fas fa-arrow-up"></i>

              {' '}

              My Transfer Requests

            </h3>


            {outgoingTransfers.length === 0 ? (

              <div
                style={{
                  textAlign: 'center',
                  padding: '50px'
                }}
              >

                <i
                  className="fas fa-paper-plane"
                  style={{
                    fontSize: '48px',
                    color: 'var(--border)'
                  }}
                ></i>

                <h3>
                  No Active Requests
                </h3>

                <p
                  style={{
                    color: 'var(--gray)'
                  }}
                >
                  You have not submitted any
                  active transfer requests.
                </p>

              </div>

            ) : (

              outgoingTransfers.map(
                transfer =>
                  renderTransferCard(
                    transfer,
                    'outgoing'
                  )
              )

            )}

          </div>

        )}


        {/* ====================================================
             HISTORY
        ===================================================== */}

        {activeTab === 'history' && (

          <div>

            <h3
              style={{
                marginBottom: '15px'
              }}
            >

              <i className="fas fa-history"></i>

              {' '}

              Transfer History

            </h3>


            {transfers.filter(
              transfer =>
                transfer.status ===
                  TRANSFER_STATUS.COMPLETED ||
                transfer.status ===
                  TRANSFER_STATUS.DECLINED
            ).length === 0 ? (

              <div
                style={{
                  textAlign: 'center',
                  padding: '50px'
                }}
              >

                <i
                  className="fas fa-history"
                  style={{
                    fontSize: '48px',
                    color: 'var(--border)'
                  }}
                ></i>

                <h3>
                  No Transfer History
                </h3>

                <p
                  style={{
                    color: 'var(--gray)'
                  }}
                >
                  Completed and declined transfers
                  will appear here.
                </p>

              </div>

            ) : (

              transfers
                .filter(
                  transfer =>
                    transfer.status ===
                      TRANSFER_STATUS.COMPLETED ||
                    transfer.status ===
                      TRANSFER_STATUS.DECLINED
                )
                .map(
                  transfer =>
                    renderTransferCard(
                      transfer,
                      'history'
                    )
                )

            )}

          </div>

        )}

      </div>


      {/* ======================================================
           RELEASE VERIFICATION MODAL
      ======================================================= */}

      <div
        className={
          `modal-overlay ${
            showReleaseModal
              ? 'active'
              : ''
          }`
        }
      >

        <div className="modal">

          <div className="modal-header">

            <h2>
              Verify Student Transfer
            </h2>

            <button
              className="modal-close"
              onClick={() => {

                setShowReleaseModal(false);
                setReleaseTransfer(null);
                setReleaseStudent(null);

              }}
            >

              <i className="fas fa-times"></i>

            </button>

          </div>


          {releaseTransfer && (

            <>

              <div
                className="verification-box"
              >

                <div
                  style={{
                    fontSize: '12px',
                    color: 'var(--gray)'
                  }}
                >
                  Transfer requested by
                </div>

                <strong>
                  {releaseTransfer.receivingSchoolName}
                </strong>


                <div
                  style={{
                    marginTop: '15px',
                    fontSize: '13px'
                  }}
                >

                  <strong>
                    Admission Number:
                  </strong>

                  {' '}

                  {releaseTransfer.admissionNumber}

                </div>


                {releaseTransfer.requestedStudentName && (

                  <div
                    style={{
                      marginTop: '5px',
                      fontSize: '13px'
                    }}
                  >

                    <strong>
                      Name supplied:
                    </strong>

                    {' '}

                    {releaseTransfer.requestedStudentName}

                  </div>

                )}

              </div>


              {!releaseStudent && (

                <>

                  <p
                    style={{
                      color: 'var(--secondary)'
                    }}
                  >

                    Search your school's student
                    records to verify the admission
                    number before releasing the student.

                  </p>


                  <button
                    className="btn btn-primary"
                    style={{
                      width: '100%'
                    }}
                    onClick={
                      verifyStudentForRelease
                    }
                    disabled={
                      releaseSearching ||
                      processing
                    }
                  >

                    {releaseSearching ? (

                      <>
                        <i className="fas fa-spinner fa-spin"></i>
                        Verifying...
                      </>

                    ) : (

                      <>
                        <i className="fas fa-search"></i>
                        Verify Student
                      </>

                    )}

                  </button>

                </>

              )}


              {releaseStudent && (

                <>

                  <div
                    className="verification-box student-verified"
                  >

                    <div
                      style={{
                        fontSize: '12px',
                        color: 'var(--gray)'
                      }}
                    >
                      Student Verified
                    </div>

                    <h3
                      style={{
                        margin: '5px 0'
                      }}
                    >

                      {releaseStudent.firstName}

                      {' '}

                      {releaseStudent.lastName}

                    </h3>


                    <div
                      style={{
                        fontSize: '13px'
                      }}
                    >

                      <strong>
                        Admission:
                      </strong>

                      {' '}

                      {releaseStudent.studentId}

                    </div>


                    {releaseStudent.class && (

                      <div
                        style={{
                          fontSize: '13px',
                          marginTop: '4px'
                        }}
                      >

                        <strong>
                          Class:
                        </strong>

                        {' '}

                        {releaseStudent.class}

                      </div>

                    )}

                  </div>


                  <div
                    className="student-notice"
                  >

                    <i className="fas fa-info-circle"></i>

                    {' '}

                    By releasing this student, their
                    academic records will be packaged
                    securely for the receiving school.

                  </div>


                  <div className="modal-footer">

                    <button
                      className="btn btn-outline"
                      onClick={() => {

                        setShowReleaseModal(false);
                        setReleaseTransfer(null);
                        setReleaseStudent(null);

                      }}
                    >
                      Cancel
                    </button>


                    <button
                      className="btn btn-success"
                      onClick={
                        handleReleaseStudent
                      }
                      disabled={processing}
                    >

                      {processing ? (

                        <>
                          <i className="fas fa-spinner fa-spin"></i>
                          Releasing...
                        </>

                      ) : (

                        <>
                          <i className="fas fa-check"></i>
                          Confirm Release
                        </>

                      )}

                    </button>

                  </div>

                </>

              )}

            </>

          )}

        </div>

      </div>


      {/* ======================================================
           DECLINE MODAL
      ======================================================= */}

      <div
        className={
          `modal-overlay ${
            showDeclineModal
              ? 'active'
              : ''
          }`
        }
      >

        <div className="modal">

          <div className="modal-header">

            <h2>
              Decline Transfer
            </h2>

            <button
              className="modal-close"
              onClick={() => {

                setShowDeclineModal(false);
                setSelectedTransfer(null);
                setDeclineReason('');

              }}
            >

              <i className="fas fa-times"></i>

            </button>

          </div>


          <p
            style={{
              color: 'var(--secondary)'
            }}
          >

            Please provide a reason for declining
            this transfer request.

          </p>


          <div className="form-group">

            <label>
              Reason
              {' '}
              <span className="required">
                *
              </span>
            </label>

            <textarea
              rows="5"
              placeholder="Explain why the transfer cannot be released..."
              value={declineReason}
              onChange={event =>
                setDeclineReason(
                  event.target.value
                )
              }
            />

          </div>


          <div className="modal-footer">

            <button
              className="btn btn-outline"
              onClick={() => {

                setShowDeclineModal(false);
                setSelectedTransfer(null);
                setDeclineReason('');

              }}
            >
              Cancel
            </button>


            <button
              className="btn btn-danger"
              onClick={
                handleDeclineTransfer
              }
              disabled={
                processing ||
                !declineReason.trim()
              }
            >

              {processing
                ? 'Processing...'
                : 'Decline Transfer'}

            </button>

          </div>

        </div>

      </div>

    </Layout>

  );

}
