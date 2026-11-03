import { createClient } from '@supabase/supabase-js';
import { fetchNetlifyFunction } from './netlifyApi';

const source = process.env.REACT_APP_AUTH_MIGRATION_SOURCE;
const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

let client;

export function getSupabaseClient() {
    if (!source) return null;
    if (!['ku', 'kiwanja'].includes(source)) {
        throw new Error('REACT_APP_AUTH_MIGRATION_SOURCE must be ku or kiwanja.');
    }
    if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error('Supabase Auth is enabled but its public URL or anon key is missing.');
    }
    if (!client) {
        client = createClient(supabaseUrl, supabaseAnonKey, {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: false,
            },
        });
    }
    return client;
}

async function migrateLegacyPassword(email, password) {
    const response = await fetchNetlifyFunction('migrate-firebase-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, source }),
    });
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error('The account migration service returned an invalid response.');
    }
    if (!response.ok || result?.success !== true) {
        throw new Error(result?.message || 'Could not migrate this account password.');
    }
}

export async function authenticateWithSupabase({
    client: supabase,
    email,
    password,
    sourceProject,
    migratePassword = migrateLegacyPassword,
}) {
    const attempt = () => supabase.auth.signInWithPassword({ email, password });
    let result = await attempt();
    if (result.error) {
        if (!['invalid_credentials', 'user_not_found'].includes(result.error.code)) {
            throw result.error;
        }
        await migratePassword(email, password, sourceProject);
        result = await attempt();
        if (result.error) throw result.error;
    }

    const authUserId = result.data?.user?.id;
    const session = result.data?.session;
    if (!authUserId || !session) {
        throw new Error('Supabase Auth returned an incomplete session.');
    }

    const membershipResult = await supabase
        .from('firebase_migration_user_tenant_memberships')
        .select('source_project, school_id, role')
        .eq('auth_user_id', authUserId)
        .eq('source_project', sourceProject)
        .limit(1);
    if (membershipResult.error) {
        await supabase.auth.signOut({ scope: 'local' });
        throw membershipResult.error;
    }
    const membership = membershipResult.data?.[0];
    if (!membership) {
        await supabase.auth.signOut({ scope: 'local' });
        throw new Error('No approved school membership exists for this app.');
    }

    return { session, user: result.data.user, membership };
}

export async function signInToSupabase(email, password) {
    const supabase = getSupabaseClient();
    if (!supabase) return { status: 'not-configured' };
    const signOutResult = await supabase.auth.signOut({ scope: 'local' });
    if (signOutResult.error) throw signOutResult.error;
    const linked = await authenticateWithSupabase({
        client: supabase,
        email,
        password,
        sourceProject: source,
    });
    return { status: 'linked', ...linked };
}
