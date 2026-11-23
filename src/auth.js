import { supabase } from './supabase.js';

// Current user state shared by all pages.
export const auth = {
  session: null,
  profile: null, // row from public.profiles, or null if missing
  get isAdmin() {
    return this.profile?.active && this.profile.app_role === 'admin';
  },
  get isMember() {
    return Boolean(this.profile?.active);
  },
};

export async function loadSession() {
  const { data } = await supabase.auth.getSession();
  auth.session = data.session;
  await loadProfile();
}

export async function loadProfile() {
  auth.profile = null;
  if (!auth.session) return;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, app_role, active')
    .eq('id', auth.session.user.id)
    .maybeSingle();
  if (error) console.error('Could not load profile', error);
  auth.profile = data;
}

export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email: email.trim(), password });
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function changePassword(password) {
  return supabase.auth.updateUser({ password });
}
