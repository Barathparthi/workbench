-- Workspace templates (03 §3.7). Image references point at the development runtime image until Phase 05
-- publishes per-toolchain images by digest.
INSERT INTO workspace_templates (id, display_name, image_ref, default_profile) VALUES
  ('tpl_python_pytest', 'Python (pytest)', 'qews/runtime:dev', 'standard'),
  ('tpl_java_maven', 'Java (Maven)', 'qews/runtime:dev', 'standard')
ON CONFLICT (id) DO NOTHING;
