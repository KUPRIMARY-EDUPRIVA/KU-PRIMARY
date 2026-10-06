const { withCors } = require('./_lib/cors');
// netlify/functions/generate-remarks.js

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
    }

    try {
        const { average } = JSON.parse(event.body || '{}');
        
        if (typeof average !== 'number') {
            return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid average' }) };
        }

        let teacherRemark = '';
        let principalRemark = '';

        if (average >= 75) {
            teacherRemark = 'Outstanding performance! You have shown exceptional mastery of the subjects. Keep up the excellent work.';
            principalRemark = 'An exemplary performance. Your dedication to academic excellence is commendable. Maintain this standard.';
        } else if (average >= 65) {
            teacherRemark = 'Very good work. You are performing well across most subjects. Continue to strive for excellence.';
            principalRemark = 'A strong performance. Your consistent hard work is clearly reflected in these results. Well done.';
        } else if (average >= 50) {
            teacherRemark = 'Good effort. You have shown improvement, but there is still room for better performance in some areas.';
            principalRemark = 'A satisfactory performance. With more focused study and discipline, you can achieve even higher goals.';
        } else if (average >= 40) {
            teacherRemark = 'You are performing at a satisfactory level, but need more dedication and consistent study habits.';
            principalRemark = 'Your performance is acceptable, but I encourage you to apply yourself more diligently to improve your grades.';
        } else {
            teacherRemark = 'Your performance is below expectations. You need to work much harder and seek assistance in your weaker subjects.';
            principalRemark = 'These results are concerning. Immediate and consistent improvement is required. Please discuss with your subject teachers.';
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                teacherRemark,
                principalRemark
            })
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ success: false, message: error.message }) };
    }
};

exports.handler = withCors(exports.handler);
