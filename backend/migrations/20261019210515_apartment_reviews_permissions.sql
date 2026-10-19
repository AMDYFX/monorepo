-- Add apartment reviews moderation permissions
BEGIN;

-- Ensure resources exist
INSERT INTO resources (name, description)
VALUES ('listings', 'Property listings management')
ON CONFLICT (name) DO NOTHING;

-- Ensure actions exist
INSERT INTO actions (name, description)
VALUES ('moderate', 'Moderate content')
ON CONFLICT (name) DO NOTHING;

-- Get the admin role
WITH admin_role AS (
  SELECT id FROM roles WHERE name = 'admin' LIMIT 1
),
listings_resource AS (
  SELECT id FROM resources WHERE name = 'listings' LIMIT 1
),
moderate_action AS (
  SELECT id FROM actions WHERE name = 'moderate' LIMIT 1
),
permission_id AS (
  SELECT p.id FROM permissions p
  JOIN listings_resource lr ON p.resource_id = lr.id
  JOIN moderate_action ma ON p.action_id = ma.id
  LIMIT 1
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT admin_role.id, permission_id.id
FROM admin_role, permission_id
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp
  WHERE rp.role_id = admin_role.id AND rp.permission_id = permission_id.id
);

COMMIT;
