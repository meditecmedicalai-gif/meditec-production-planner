import { supabase } from './supabase.js';

// Live updates via Supabase Realtime. The database only sends a change to
// users whose RLS policies allow them to read that row (see migration 004).
export const LIVE_TABLES = ['assignments', 'absences', 'demand_notes', 'people', 'person_skills',
  'pump_models', 'tasks', 'build_types', 'equipment', 'app_settings', 'test_areas', 'test_area_shared_tasks',
  'test_limits', 'test_limit_models', 'recurring_jobs', 'recurring_exceptions',
  'work_patterns', 'work_pattern_days', 'person_work_patterns', 'person_day_hours',
  'todos', 'pump_model_stages', 'demand_progress', 'demand_stage_plans'];

let channel = null;

export function startRealtime({ onChange, onStatus }) {
  stopRealtime();
  channel = supabase.channel('planner-live');
  for (const table of LIVE_TABLES) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => onChange(payload));
  }
  channel.subscribe((status) => onStatus?.(status === 'SUBSCRIBED'));
}

export function stopRealtime() {
  if (channel) supabase.removeChannel(channel);
  channel = null;
}
