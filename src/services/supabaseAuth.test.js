import { authenticateWithSupabase } from './supabaseAuth';

function createSupabaseMock({ signInResults, memberships = [{ source_project: 'ku', school_id: 'school-1', role: 'teacher' }] }) {
    const signOut = jest.fn().mockResolvedValue({ error: null });
    const signInWithPassword = jest.fn();
    signInResults.forEach((result) => signInWithPassword.mockResolvedValueOnce(result));
    const limit = jest.fn().mockResolvedValue({ data: memberships, error: null });
    const eqSource = jest.fn(() => ({ limit }));
    const eqUser = jest.fn(() => ({ eq: eqSource }));
    const select = jest.fn(() => ({ eq: eqUser }));
    const from = jest.fn(() => ({ select }));
    return {
        auth: { signInWithPassword, signOut },
        from,
        signInWithPassword,
        signOut,
        select,
    };
}

const signedIn = {
    data: {
        user: { id: 'auth-uuid' },
        session: { access_token: 'session-token' },
    },
    error: null,
};

test('uses an existing Supabase password and validates the source membership', async () => {
    const client = createSupabaseMock({ signInResults: [signedIn] });
    const linked = await authenticateWithSupabase({
        client,
        email: 'teacher@example.test',
        password: 'password',
        sourceProject: 'ku',
    });

    expect(linked.user.id).toBe('auth-uuid');
    expect(linked.membership.school_id).toBe('school-1');
    expect(client.from).toHaveBeenCalledWith('firebase_migration_user_tenant_memberships');
    expect(client.signInWithPassword).toHaveBeenCalledTimes(1);
});

test('migrates a legacy password only after Supabase rejects the existing credential', async () => {
    const client = createSupabaseMock({
        signInResults: [
            { data: { user: null, session: null }, error: { code: 'invalid_credentials' } },
            signedIn,
        ],
    });
    const migratePassword = jest.fn().mockResolvedValue(undefined);
    await authenticateWithSupabase({
        client,
        email: 'teacher@example.test',
        password: 'legacy-password',
        sourceProject: 'kiwanja',
        migratePassword,
    });

    expect(migratePassword).toHaveBeenCalledWith('teacher@example.test', 'legacy-password', 'kiwanja');
    expect(client.signInWithPassword).toHaveBeenCalledTimes(2);
});

test('does not migrate after unrelated Supabase Auth errors', async () => {
    const client = createSupabaseMock({
        signInResults: [{ data: { user: null, session: null }, error: { code: 'network_error' } }],
    });
    const migratePassword = jest.fn();

    await expect(authenticateWithSupabase({
        client,
        email: 'teacher@example.test',
        password: 'password',
        sourceProject: 'ku',
        migratePassword,
    })).rejects.toMatchObject({ code: 'network_error' });
    expect(migratePassword).not.toHaveBeenCalled();
});

test('signs out locally when the UUID has no membership in the selected source', async () => {
    const client = createSupabaseMock({ signInResults: [signedIn], memberships: [] });
    await expect(authenticateWithSupabase({
        client,
        email: 'teacher@example.test',
        password: 'password',
        sourceProject: 'kiwanja',
    })).rejects.toThrow('No approved school membership');
    expect(client.signOut).toHaveBeenCalledWith({ scope: 'local' });
});
