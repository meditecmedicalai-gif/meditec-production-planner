-- What migration 012's one-off set-up did. Run after 012 (read-only).
select
  (select string_agg(name, ', ' order by sort_order) from public.tasks where category = 'office')            as office_tasks,
  (select count(*) from public.pump_models m where exists (select 1 from public.pump_model_stages s where s.pump_model_id = m.id))
                                                                                                             as pump_models_with_stages,
  (select string_agg(m.name || ': ' || st.stages, ' | ' order by m.sort_order)
     from public.pump_models m
     join lateral (select string_agg(t.name, ' → ' order by s.position) as stages
                   from public.pump_model_stages s join public.tasks t on t.id = s.task_id
                   where s.pump_model_id = m.id) st on true)                                                 as stages_per_model,
  -- notes whose hand-set "Planned" was cleared (logged by the change log when the migration ran)
  (select count(distinct record_id) from public.audit_log
    where table_name = 'demand_notes' and action = 'update' and changed_by is null
      and old_data ->> 'status_override' in ('planned', 'partly') and new_data ->> 'status_override' is null)
                                                                                                             as notes_back_to_automatic,
  (select count(*) from public.demand_notes where status_override = 'done')                                  as notes_still_marked_done_by_hand;
