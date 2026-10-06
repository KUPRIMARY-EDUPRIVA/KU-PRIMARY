// src/pages/PlatformAdmin/Users.jsx
import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { db } from '../../firebase';
import { collection, query, getDocs, doc, deleteDoc, updateDoc } from 'firebase/firestore';
import { fetchNetlifyFunction } from '../../services/netlifyApi';
import { normalizeRole } from '../../utils/roles';
import Layout from '../../components/Layout/Layout';
import LoadingSpinner from '../../components/Common/LoadingSpinner';

const MANAGED_ADMIN_ROLES = new Set([
    'admin', 'user', 'school-admin', 'principal',
    'headteacher', 'deputy-headteacher', 'accountant', 'finance',
]);

async function platformAdminAction(currentUser, action, details = {}) {
    const token = await currentUser.getIdToken();
    const response = await fetchNetlifyFunction('manage-school-admins', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action, ...details }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
        throw new Error(result.error || 'Administrator operation failed.');
    }
    return result;
}

export default function PlatformUsers() {
    const { currentUser } = useAuth();
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        loadUsers();
    }, []);

    const loadUsers = async () => {
        setLoading(true);
        try {
            const usersQuery = query(collection(db, 'users'));
            const snapshot = await getDocs(usersQuery);
            const usersData = [];
            snapshot.forEach(doc => {
                usersData.push({ id: doc.id, ...doc.data() });
            });
            setUsers(usersData);
        } catch (error) {
            console.error('Error loading users:', error);
            alert('Failed to load users');
        } finally {
            setLoading(false);
        }
    };

    const handleRoleChange = async (userId, newRole) => {
        try {
            const selectedUser = users.find((user) => user.id === userId);
            if (!selectedUser) throw new Error('User not found.');
            const currentRole = normalizeRole(selectedUser.role);
            if (MANAGED_ADMIN_ROLES.has(currentRole) && currentRole !== normalizeRole(newRole)) {
                throw new Error('Administrator accounts cannot be reassigned. Request account deletion and obtain the account owner’s approval first.');
            }
            if (normalizeRole(newRole) === 'admin' && currentRole !== 'admin') {
                await platformAdminAction(currentUser, 'platform-set-role', { targetUid: userId, role: 'admin' });
                await loadUsers();
                alert('Admin role assigned successfully.');
                return;
            }
            await updateDoc(doc(db, 'users', userId), { role: newRole });
            setUsers(users.map(u => 
                u.id === userId ? { ...u, role: newRole } : u
            ));
            alert('User role updated successfully!');
        } catch (error) {
            console.error('Error updating role:', error);
            alert('Failed to update role');
        }
    };

    const handleDeleteUser = async (userId) => {
        const target = users.find((user) => user.id === userId);
        if (!target) return;
        const isManagedAdmin = MANAGED_ADMIN_ROLES.has(normalizeRole(target.role));
        const confirmation = isManagedAdmin
            ? 'This will request deletion of the administrator account. The account owner must approve before their sign-in credentials and school record are deleted. Continue?'
            : 'Are you sure you want to delete this user?';
        if (!window.confirm(confirmation)) return;
        try {
            if (isManagedAdmin) {
                await platformAdminAction(currentUser, 'platform-request-deletion', { targetUid: userId });
                alert('Deletion request sent. The account owner must approve it before removal.');
                return;
            }
            await deleteDoc(doc(db, 'users', userId));
            setUsers(users.filter(u => u.id !== userId));
            alert('User deleted successfully!');
        } catch (error) {
            console.error('Error deleting user:', error);
            alert('Failed to delete user');
        }
    };

    const filteredUsers = users.filter(user => 
        (user.fullName || user.firstName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (user.email || '').toLowerCase().includes(searchTerm.toLowerCase())
    );

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading users..." />;
    }

    return (
        <Layout title="Platform Users">
            <div style={{ padding: '20px' }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '20px',
                    flexWrap: 'wrap',
                    gap: '10px'
                }}>
                    <h2 style={{ color: 'var(--secondary)' }}>
                        <i className="fas fa-users-cog"></i> Platform Users
                    </h2>
                    <input
                        type="text"
                        placeholder="Search users..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{
                            padding: '10px 15px',
                            border: '2px solid var(--border)',
                            borderRadius: '8px',
                            fontSize: '14px',
                            minWidth: '250px'
                        }}
                    />
                </div>

                <div style={{
                    background: 'white',
                    borderRadius: '12px',
                    boxShadow: 'var(--shadow)',
                    overflow: 'hidden'
                }}>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ background: 'var(--light)' }}>
                                    <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>User</th>
                                    <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Email</th>
                                    <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Role</th>
                                    <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>School ID</th>
                                    <th style={{ padding: '12px 20px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredUsers.length === 0 ? (
                                    <tr>
                                        <td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: 'var(--gray)' }}>
                                            <i className="fas fa-users" style={{ fontSize: '48px', display: 'block', marginBottom: '15px', color: 'var(--border)' }}></i>
                                            No users found
                                        </td>
                                    </tr>
                                ) : (
                                    filteredUsers.map(user => (
                                        <tr key={user.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td style={{ padding: '12px 20px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                    <div style={{
                                                        width: '35px',
                                                        height: '35px',
                                                        borderRadius: '50%',
                                                        background: 'var(--primary)',
                                                        color: 'white',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        fontWeight: '600',
                                                        fontSize: '14px'
                                                    }}>
                                                        {(user.fullName || user.firstName || 'U')[0].toUpperCase()}
                                                    </div>
                                                    <span style={{ fontWeight: '500' }}>
                                                        {user.fullName || user.firstName || 'Unknown'}
                                                    </span>
                                                </div>
                                            </td>
                                            <td style={{ padding: '12px 20px', color: 'var(--gray)' }}>
                                                {user.email || 'N/A'}
                                            </td>
                                            <td style={{ padding: '12px 20px' }}>
                                                <select
                                                    value={user.role || 'user'}
                                                    onChange={(e) => handleRoleChange(user.id, e.target.value)}
                                                    style={{
                                                        padding: '4px 10px',
                                                        border: '2px solid var(--border)',
                                                        borderRadius: '6px',
                                                        fontSize: '12px',
                                                        background: 'white'
                                                    }}
                                                >
                                                    <option value="user">User</option>
                                                    <option value="admin">Admin</option>
                                                    <option value="teacher">Teacher</option>
                                                    <option value="student">Student</option>
                                                    <option value="super-admin">Super Admin</option>
                                                </select>
                                            </td>
                                            <td style={{ padding: '12px 20px', fontSize: '13px', color: 'var(--gray)' }}>
                                                {user.schoolId || 'N/A'}
                                            </td>
                                            <td style={{ padding: '12px 20px', textAlign: 'center' }}>
                                                <button
                                                    onClick={() => handleDeleteUser(user.id)}
                                                    style={{
                                                        padding: '5px 12px',
                                                        background: 'var(--danger)',
                                                        color: 'white',
                                                        border: 'none',
                                                        borderRadius: '6px',
                                                        cursor: 'pointer',
                                                        fontSize: '12px',
                                                        transition: 'all 0.3s'
                                                    }}
                                                    onMouseEnter={(e) => e.currentTarget.style.opacity = '0.8'}
                                                    onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                                                >
                                                    <i className="fas fa-trash"></i> Delete
                                                </button>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </Layout>
    );
}
