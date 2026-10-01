// netlify/functions/schedule-deletion.js
// Or Firebase Cloud Function

const admin = require('firebase-admin');
const functions = require('firebase-functions');

exports.scheduledDeletion = functions.pubsub
  .schedule('0 0 * * *') // Runs daily at midnight
  .onRun(async (context) => {
    const db = admin.firestore();
    const now = new Date();
    
    // Find expired exits
    const exitsSnapshot = await db.collection('school_exits')
      .where('status', '==', 'ready')
      .where('retentionEndDate', '<=', now.toISOString())
      .get();
    
    for (const exitDoc of exitsSnapshot.docs) {
      const exitData = exitDoc.data();
      
      // Delete all school data
      const collections = [
        'students',
        'teachers',
        'exams',
        'student_scores',
        'exam_submissions',
        'fee_invoices',
        'fee_payments'
      ];
      
      const batch = db.batch();
      
      for (const collectionName of collections) {
        const q = db.collection(collectionName)
          .where('schoolId', '==', exitData.schoolId);
        const snapshot = await q.get();
        snapshot.docs.forEach(doc => {
          batch.delete(doc.ref);
        });
      }
      
      await batch.commit();
      
      // Update exit record
      await db.collection('school_exits').doc(exitDoc.id).update({
        status: 'deleted',
        'deletionSchedule.completed': true,
        'deletionSchedule.deletedAt': now.toISOString()
      });
      
      console.log(`Deleted data for school: ${exitData.schoolId}`);
    }
    
    return null;
  });
