import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const SUPPORT_EMAIL = 'info.edupriva@gmail.com';
const SUPPORT_PHONE = '+254114963959';

const pageContent = {
    '/terms': {
        title: 'Terms of Service',
        intro: 'These terms explain the basic conditions for using EDUPRIVA school-management services.',
        sections: [
            ['Account access', 'Use an account assigned to you, keep your sign-in details private, and tell your school administrator if you believe your account has been accessed without permission. Schools are responsible for assigning appropriate roles and keeping their account details current.'],
            ['Acceptable use', 'Use the system for legitimate school administration and learning-related activities. Do not attempt to access another school’s records, disrupt the service, or use communication tools unlawfully.'],
            ['School records and communications', 'The school is responsible for the accuracy and lawful use of records it enters, including student information, fees, results, attendance, and messages sent to families. Review recipients and message content before sending a campaign.'],
            ['Availability and offline use', 'Some features require an internet connection. Offline access depends on information previously synchronized to the device and may not include the latest changes. Keep devices secured and sign out or lock access when appropriate.'],
            ['Service changes', 'Features may change to maintain or improve the service. Subscription terms, where applicable, are communicated separately to the school.'],
            ['Contact', `For help with these terms, contact ${SUPPORT_EMAIL} or ${SUPPORT_PHONE}.`],
        ],
    },
    '/privacy': {
        title: 'Privacy Policy',
        intro: 'This policy describes how information handled through EDUPRIVA is used in providing school-management features.',
        sections: [
            ['Information in the system', 'Depending on the features used, a school may enter account details, student and guardian details, attendance, academic results, fee records, health or discipline notes, and school communications. The school determines what records it enters and who is authorized to access them.'],
            ['How information is used', 'Information is processed to provide the requested school-management functions, authenticate users, synchronize records, generate reports, support school communications, and maintain the operation and security of the service.'],
            ['Service providers and messages', 'The service uses infrastructure providers to support authentication, storage, and server functions. SMS or other messages may be transmitted through the school’s configured provider or device SIM. Those providers process information needed to deliver the requested service under their own terms.'],
            ['Device storage and offline access', 'Some information may be cached on a device so previously synchronized features can work offline. Protect devices with a screen lock, keep the application updated, and remove access from devices that are lost or no longer used by authorized staff.'],
            ['Access, retention, and questions', 'Schools manage their users and records and should direct requests about school records to their school administrator. For questions about this policy or the service, contact EDUPRIVA support.'],
            ['Contact', `Email ${SUPPORT_EMAIL} or call/WhatsApp ${SUPPORT_PHONE}.`],
        ],
    },
};

export default function LegalPages() {
    const { pathname } = useLocation();
    if (pathname === '/support') {
        return (
            <PublicInfoLayout title="EDUPRIVA Support" intro="Contact our support team for help using EDUPRIVA.">
                <div className="legal-contact-actions">
                    <a href={`mailto:${SUPPORT_EMAIL}?subject=EDUPRIVA%20Support`}>Email {SUPPORT_EMAIL}</a>
                    <a href={`https://wa.me/${SUPPORT_PHONE.replace('+', '')}`} target="_blank" rel="noreferrer">
                        WhatsApp {SUPPORT_PHONE}
                    </a>
                    <a href={`tel:${SUPPORT_PHONE}`}>Call {SUPPORT_PHONE}</a>
                </div>
                <h2>When contacting support</h2>
                <p>Include the app variant (EDUPRIVA KU or EDUPRIVA KIWANJA), the page you were using, and a description of the issue. Do not send passwords or other authentication secrets.</p>
            </PublicInfoLayout>
        );
    }

    const content = pageContent[pathname] || pageContent['/terms'];
    return (
        <PublicInfoLayout title={content.title} intro={content.intro}>
            {content.sections.map(([heading, text]) => (
                <section key={heading}>
                    <h2>{heading}</h2>
                    <p>{text}</p>
                </section>
            ))}
        </PublicInfoLayout>
    );
}

function PublicInfoLayout({ title, intro, children }) {
    return (
        <main style={{ minHeight: '100vh', background: '#f5f7fb', padding: '32px 16px', color: '#253047' }}>
            <article style={{ maxWidth: 820, margin: '0 auto', padding: '28px', background: '#fff', borderRadius: 16, boxShadow: '0 8px 28px rgba(20,35,80,.1)', lineHeight: 1.65 }}>
                <Link to="/login" style={{ color: '#3156a3', textDecoration: 'none' }}>← Back to EDUPRIVA</Link>
                <h1 style={{ margin: '18px 0 8px', color: '#1a237e' }}>{title}</h1>
                <p style={{ marginBottom: 20 }}>{intro}</p>
                <div className="legal-page-content">{children}</div>
                <nav aria-label="Legal pages" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 28, borderTop: '1px solid #e3e8f0', paddingTop: 16 }}>
                    <Link to="/terms">Terms of Service</Link>
                    <Link to="/privacy">Privacy Policy</Link>
                    <Link to="/support">Support</Link>
                </nav>
            </article>
            <style>{`
                .legal-page-content h2 { margin: 20px 0 6px; color: #263861; font-size: 17px; }
                .legal-page-content p { margin: 0; }
                .legal-page-content a, main nav a { color: #3156a3; }
                .legal-contact-actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 18px 0; }
                .legal-contact-actions a { display: inline-block; padding: 10px 14px; border-radius: 8px; background: #1a237e; color: white; text-decoration: none; }
            `}</style>
        </main>
    );
}
