-- Add support resource permissions for admin role
BEGIN;

-- Insert the 'support' resource if it doesn't exist
INSERT INTO resources (name, description)
VALUES ('support', 'Support message management')
ON CONFLICT (name) DO NOTHING;

-- Insert the 'view' action if it doesn't exist
INSERT INTO actions (name, description)
VALUES ('view', 'View resource')
ON CONFLICT (name) DO NOTHING;

-- Get the admin role (typically role_id = 2, but query to be safe)
WITH admin_role AS (
  SELECT id FROM roles WHERE name = 'admin' LIMIT 1
),
support_resource AS (
  SELECT id FROM resources WHERE name = 'support' LIMIT 1
),
view_action AS (
  SELECT id FROM actions WHERE name = 'view' LIMIT 1
),
permission_id AS (
  SELECT p.id FROM permissions p
  JOIN support_resource sr ON p.resource_id = sr.id
  JOIN view_action va ON p.action_id = va.id
  WHERE p.resource_id = sr.id AND p.action_id = va.id
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
