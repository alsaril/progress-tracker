-- A SAMPLE tree, for local development and CI only.
--
-- Your real objectives do not belong here: build them from the bot with /add,
-- so they live in the database rather than in this (public) repository. This
-- file exists so `npm run seed:local` gives the end-to-end harness a known tree
-- to assert against, and so a fresh clone has something to click.
--
-- Contents are the music example from the design document.
--
-- IDEMPOTENT, like the migration's CREATE TABLE IF NOT EXISTS / INSERT OR
-- IGNORE: re-running it neither duplicates nor errors. Plain INSERTs produced
-- two of every objective on a second run, and duplicate OBJECTIVE names cannot
-- be disambiguated the way duplicate child names can (there is no grandparent
-- to qualify them with), which left the tree unrepairable from the bot.
--
-- Weights are RELATIVE and need not sum to anything (design section 2.4).
-- Shares are derived on read by renormalising over the active set, so 3/4/2/1
-- below is the same target distribution as 30/40/20/10.
--
-- Every objective gets a default child named after it (design section 2.2), so
-- points are always recorded against a leaf and the bot can skip the second
-- keyboard for objectives that have no real sub-objectives yet.

-- One block per objective. To add one, copy a block and change the name,
-- weight and sort order; the guards need no editing.

-- ----------------------------------------------------- Technique
INSERT INTO objectives (name, weight, sort_order)
  SELECT 'Technique', 3.0, 1
  WHERE NOT EXISTS (SELECT 1 FROM objectives WHERE name = 'Technique');

INSERT INTO sub_objectives (objective_id, name, is_default, sort_order)
  SELECT o.id, 'Technique', 1, 0 FROM objectives o WHERE o.name = 'Technique'
    AND NOT EXISTS (SELECT 1 FROM sub_objectives s
                     WHERE s.objective_id = o.id AND s.name = 'Technique');

-- ---------------------------------------------------- Repertoire
INSERT INTO objectives (name, weight, sort_order)
  SELECT 'Repertoire', 4.0, 2
  WHERE NOT EXISTS (SELECT 1 FROM objectives WHERE name = 'Repertoire');

INSERT INTO sub_objectives (objective_id, name, is_default, sort_order)
  SELECT o.id, 'Repertoire', 1, 0 FROM objectives o WHERE o.name = 'Repertoire'
    AND NOT EXISTS (SELECT 1 FROM sub_objectives s
                     WHERE s.objective_id = o.id AND s.name = 'Repertoire');

-- -------------------------------------------------------- Theory
INSERT INTO objectives (name, weight, sort_order)
  SELECT 'Theory', 2.0, 3
  WHERE NOT EXISTS (SELECT 1 FROM objectives WHERE name = 'Theory');

INSERT INTO sub_objectives (objective_id, name, is_default, sort_order)
  SELECT o.id, 'Theory', 1, 0 FROM objectives o WHERE o.name = 'Theory'
    AND NOT EXISTS (SELECT 1 FROM sub_objectives s
                     WHERE s.objective_id = o.id AND s.name = 'Theory');
-- Real sub-objectives alongside the default child, which keeps its own
-- history and is never silently deleted (design section 2.2).
INSERT INTO sub_objectives (objective_id, name, sort_order)
  SELECT o.id, 'Intervals', 1 FROM objectives o WHERE o.name = 'Theory'
    AND NOT EXISTS (SELECT 1 FROM sub_objectives s
                     WHERE s.objective_id = o.id AND s.name = 'Intervals');
INSERT INTO sub_objectives (objective_id, name, sort_order)
  SELECT o.id, 'Harmony', 2 FROM objectives o WHERE o.name = 'Theory'
    AND NOT EXISTS (SELECT 1 FROM sub_objectives s
                     WHERE s.objective_id = o.id AND s.name = 'Harmony');

-- ------------------------------------------------- Sight-reading
INSERT INTO objectives (name, weight, sort_order)
  SELECT 'Sight-reading', 1.0, 4
  WHERE NOT EXISTS (SELECT 1 FROM objectives WHERE name = 'Sight-reading');

INSERT INTO sub_objectives (objective_id, name, is_default, sort_order)
  SELECT o.id, 'Sight-reading', 1, 0 FROM objectives o WHERE o.name = 'Sight-reading'
    AND NOT EXISTS (SELECT 1 FROM sub_objectives s
                     WHERE s.objective_id = o.id AND s.name = 'Sight-reading');
