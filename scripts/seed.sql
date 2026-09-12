-- The objective tree. EDIT THIS FILE before first use.
--
-- Placeholder contents are the music example from the design document. Since
-- /add is not in v1, this file is how the tree gets set: edit it, then re-run
--   npm run seed:local     (or seed:remote)
--
-- Weights are RELATIVE and need not sum to anything (design section 2.4).
-- Shares are derived on read by renormalising over the active set, so 3/4/2/1
-- below is the same target distribution as 30/40/20/10.
--
-- Every objective gets a default child named after it (design section 2.2), so
-- points are always recorded against a leaf and the bot can skip the second
-- keyboard for objectives that have no real sub-objectives yet.

-- One block per objective. To add one, copy a block and change the three
-- values in the INSERT ... objectives line plus the sub_objective names.

-- ---------------------------------------------------------------- Technique
INSERT INTO objectives (name, weight, sort_order) VALUES ('Technique', 3.0, 1);
INSERT INTO sub_objectives (objective_id, name, is_default, sort_order)
  VALUES (last_insert_rowid(), 'Technique', 1, 0);

-- --------------------------------------------------------------- Repertoire
INSERT INTO objectives (name, weight, sort_order) VALUES ('Repertoire', 4.0, 2);
INSERT INTO sub_objectives (objective_id, name, is_default, sort_order)
  VALUES (last_insert_rowid(), 'Repertoire', 1, 0);

-- ------------------------------------------------------------------- Theory
-- An objective with real sub-objectives alongside its default child. The
-- default child keeps any history it accumulated and is never silently
-- deleted; it can be renamed ("General", "Unsorted") or deactivated by hand.
INSERT INTO objectives (name, weight, sort_order) VALUES ('Theory', 2.0, 3);
INSERT INTO sub_objectives (objective_id, name, is_default, sort_order)
  VALUES (last_insert_rowid(), 'Theory', 1, 0);
INSERT INTO sub_objectives (objective_id, name, sort_order)
  VALUES ((SELECT id FROM objectives WHERE name = 'Theory'), 'Intervals', 1);
INSERT INTO sub_objectives (objective_id, name, sort_order)
  VALUES ((SELECT id FROM objectives WHERE name = 'Theory'), 'Harmony', 2);

-- ------------------------------------------------------------- Sight-reading
INSERT INTO objectives (name, weight, sort_order) VALUES ('Sight-reading', 1.0, 4);
INSERT INTO sub_objectives (objective_id, name, is_default, sort_order)
  VALUES (last_insert_rowid(), 'Sight-reading', 1, 0);
