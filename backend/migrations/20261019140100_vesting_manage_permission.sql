-- RBAC permission for the admin vesting endpoints (#1911):
-- POST /api/v1/admin/vesting and POST /api/v1/admin/vesting/:beneficiary/revoke.
-- Modelled on the seed in 035_admin_rbac.sql. super_admin implicitly holds every
-- permission. vesting:manage is granted to the finance role because creating a
-- schedule moves tokens from the admin account into the vesting contract.

INSERT INTO permissions (resource, action) VALUES
('vesting', 'manage')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'finance' AND (
    (p.resource = 'vesting' AND p.action = 'manage')
)
ON CONFLICT DO NOTHING;
