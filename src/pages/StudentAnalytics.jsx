import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFee } from '../context/FeeContext';
import { loadStudentRoster } from '../services/studentRosterService';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
    PieChart, Pie, Cell, LineChart, Line
} from 'recharts';
import { LEVEL_ORDER, getLevelDisplayName } from '../utils/constants';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D'];

export default function StudentAnalytics() {
    const { userData } = useAuth();
    const { feeBalances } = useFee();
    const navigate = useNavigate();
    
    const [students, setStudents] = useState([]);
    const [loading, setLoading] = useState(true);
    
    useEffect(() => {
        if (!userData?.schoolId) return;
        loadStudentRoster(userData.schoolId).then(data => {
            setStudents(data);
            setLoading(false);
        }).catch(err => {
            console.error(err);
            setLoading(false);
        });
    }, [userData?.schoolId]);

    const activeStudents = useMemo(() => students.filter(s => s.status === 'active'), [students]);

    // Data for charts
    const studentsByLevel = useMemo(() => {
        const counts = {};
        activeStudents.forEach(s => {
            if (s.level) counts[s.level] = (counts[s.level] || 0) + 1;
        });
        return LEVEL_ORDER.filter(l => counts[l]).map(level => ({
            name: getLevelDisplayName(level),
            count: counts[level]
        }));
    }, [activeStudents]);

    const genderDistribution = useMemo(() => {
        let male = 0, female = 0, other = 0, unknown = 0;
        activeStudents.forEach(s => {
            const g = (s.gender || '').toLowerCase();
            if (g === 'male' || g === 'm') male++;
            else if (g === 'female' || g === 'f') female++;
            else if (g) other++;
            else unknown++;
        });
        const res = [];
        if (male > 0) res.push({ name: 'Male', value: male });
        if (female > 0) res.push({ name: 'Female', value: female });
        if (other > 0) res.push({ name: 'Other', value: other });
        if (unknown > 0) res.push({ name: 'Unspecified', value: unknown });
        return res;
    }, [activeStudents]);

    const feeStatusData = useMemo(() => {
        let fullyPaid = 0, partial = 0, pending = 0, noInvoice = 0;
        activeStudents.forEach(s => {
            const fb = feeBalances.find(b => b.studentId === s.id);
            if (!fb) {
                noInvoice++;
            } else if (fb.balance <= 0 && fb.totalInvoiced > 0) {
                fullyPaid++;
            } else if (fb.totalPaid > 0) {
                partial++;
            } else {
                pending++;
            }
        });
        return [
            { name: 'Fully Paid', value: fullyPaid },
            { name: 'Partial Payment', value: partial },
            { name: 'Pending / Unpaid', value: pending },
            { name: 'No Invoices', value: noInvoice }
        ].filter(d => d.value > 0);
    }, [activeStudents, feeBalances]);

    const admissionTrends = useMemo(() => {
        const years = {};
        students.forEach(s => {
            if (s.admissionYear) {
                years[s.admissionYear] = (years[s.admissionYear] || 0) + 1;
            }
        });
        return Object.keys(years).sort().map(y => ({
            year: y,
            admissions: years[y]
        }));
    }, [students]);

    if (loading) return <LoadingSpinner fullScreen text="Loading Analytics..." />;

    return (
        <Layout title="Student Performance Analytics">
            <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <h2 style={{ fontSize: '24px', color: 'var(--secondary)' }}>Student & Fee Analytics</h2>
                    <button className="btn btn-outline" onClick={() => navigate('/students')}>
                        <i className="fas fa-arrow-left"></i> Back to Students
                    </button>
                </div>
                
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginBottom: '20px' }}>
                    {/* Enrollment by Level */}
                    <div style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: 'var(--shadow)' }}>
                        <h3 style={{ fontSize: '16px', marginBottom: '15px', color: 'var(--secondary)' }}>Enrollment by Level</h3>
                        <div style={{ height: '300px' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={studentsByLevel}>
                                    <CartesianGrid strokeDasharray="3 3" />
                                    <XAxis dataKey="name" tick={{fontSize: 12}} />
                                    <YAxis allowDecimals={false} />
                                    <RechartsTooltip />
                                    <Bar dataKey="count" fill="#4f46e5" radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Gender Distribution */}
                    <div style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: 'var(--shadow)' }}>
                        <h3 style={{ fontSize: '16px', marginBottom: '15px', color: 'var(--secondary)' }}>Gender Distribution</h3>
                        <div style={{ height: '300px' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie data={genderDistribution} cx="50%" cy="50%" outerRadius={100} fill="#8884d8" dataKey="value" label>
                                        {genderDistribution.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                        ))}
                                    </Pie>
                                    <RechartsTooltip />
                                    <Legend />
                                </PieChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Fee Payment Status */}
                    <div style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: 'var(--shadow)' }}>
                        <h3 style={{ fontSize: '16px', marginBottom: '15px', color: 'var(--secondary)' }}>Fee Payment Status (Current Term)</h3>
                        <div style={{ height: '300px' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie data={feeStatusData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} fill="#82ca9d" dataKey="value" label>
                                        {feeStatusData.map((entry, index) => {
                                            let color = '#8884d8';
                                            if (entry.name === 'Fully Paid') color = '#10b981';
                                            if (entry.name === 'Partial Payment') color = '#f59e0b';
                                            if (entry.name === 'Pending / Unpaid') color = '#ef4444';
                                            if (entry.name === 'No Invoices') color = '#9ca3af';
                                            return <Cell key={`cell-${index}`} fill={color} />;
                                        })}
                                    </Pie>
                                    <RechartsTooltip />
                                    <Legend />
                                </PieChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Admission Trends */}
                    <div style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: 'var(--shadow)' }}>
                        <h3 style={{ fontSize: '16px', marginBottom: '15px', color: 'var(--secondary)' }}>Historical Admission Trends</h3>
                        <div style={{ height: '300px' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={admissionTrends}>
                                    <CartesianGrid strokeDasharray="3 3" />
                                    <XAxis dataKey="year" />
                                    <YAxis allowDecimals={false} />
                                    <RechartsTooltip />
                                    <Line type="monotone" dataKey="admissions" stroke="#8b5cf6" strokeWidth={3} dot={{ r: 6 }} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>
            </div>
        </Layout>
    );
}
