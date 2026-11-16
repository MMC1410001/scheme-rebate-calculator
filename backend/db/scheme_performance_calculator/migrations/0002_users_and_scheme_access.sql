-- Users, their roles and the schemes each scheme manager may edit (5 Nov 2026). See ../README.md, "Access".
-- Roles: ADMIN (everything), SCHEME_MANAGER (edits only its own schemes and their components; product and total edits,
-- V and removing schemes are ADMIN only), VIEWER (read only). The built-in admin of the env file has no row here.

CREATE TABLE spi.app_user (
    user_id         integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username        text        NOT NULL CHECK (username ~ '^[A-Za-z0-9._@-]{1,64}$'),
    password_hash   text        NOT NULL,                       -- pbkdf2-sha256 (app/auth.py); never a password
    role            text        NOT NULL CHECK (role IN ('ADMIN', 'SCHEME_MANAGER', 'VIEWER')),
    active          boolean     NOT NULL DEFAULT true,
    access_version  integer     NOT NULL DEFAULT 1,             -- bumped on any role or scheme change: ends sessions
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_login_at   timestamptz
);
CREATE UNIQUE INDEX app_user_username_idx ON spi.app_user (lower(username));

-- The schemes a SCHEME_MANAGER may edit; a scheme's components follow from spi.component.
CREATE TABLE spi.user_scheme (
    user_id         integer     NOT NULL REFERENCES spi.app_user ON DELETE CASCADE,
    scheme_id       smallint    NOT NULL REFERENCES spi.scheme,
    granted_by      text,                                       -- who ran the grant
    granted_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, scheme_id)
);
CREATE INDEX user_scheme_scheme_idx ON spi.user_scheme (scheme_id);

-- Logins, user and access changes, version saves and archives. Append only for the app's login.
CREATE TABLE spi.audit_log (
    event_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at              timestamptz NOT NULL DEFAULT now(),
    username        text,
    action          text        NOT NULL,
    target          text,
    detail          jsonb
);
CREATE INDEX audit_log_at_idx ON spi.audit_log (at);

ALTER TABLE spi.saved_version
    ADD COLUMN updated_by    text,
    ADD COLUMN created_by_id integer REFERENCES spi.app_user ON DELETE SET NULL,
    ADD COLUMN updated_by_id integer REFERENCES spi.app_user ON DELETE SET NULL;

-- ---------- Row-level security on what a version stores ----------
-- The API sets, per transaction, who is acting: spi.role, spi.username and spi.schemes (comma-separated scheme keys).
-- Unset (the loader, the recalculation of versions, migrations): no user, every row allowed.
CREATE FUNCTION spi.acting_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('spi.role', true), '') $$;

CREATE FUNCTION spi.may_edit_scheme(scheme_key text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT spi.acting_role() IS NULL OR spi.acting_role() = 'ADMIN'
          OR (spi.acting_role() = 'SCHEME_MANAGER'
              AND scheme_key = ANY (string_to_array(current_setting('spi.schemes', true), ','))) $$;

CREATE FUNCTION spi.may_change_version(created_by text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT spi.acting_role() IS NULL OR spi.acting_role() = 'ADMIN'
          OR (spi.acting_role() = 'SCHEME_MANAGER' AND created_by = current_setting('spi.username', true)) $$;

ALTER TABLE spi.saved_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE spi.saved_version FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_version_read ON spi.saved_version FOR SELECT USING (true);
CREATE POLICY saved_version_add ON spi.saved_version FOR INSERT
    WITH CHECK (spi.acting_role() IS NULL OR spi.acting_role() IN ('ADMIN', 'SCHEME_MANAGER'));
CREATE POLICY saved_version_change ON spi.saved_version FOR UPDATE
    USING (spi.may_change_version(created_by)) WITH CHECK (spi.may_change_version(created_by));
CREATE POLICY saved_version_drop ON spi.saved_version FOR DELETE USING (spi.may_change_version(created_by));

-- A stored edit: a scheme's own (modes S and C name the scheme) for its manager; product and total edits ADMIN only.
ALTER TABLE spi.saved_version_edit ENABLE ROW LEVEL SECURITY;
ALTER TABLE spi.saved_version_edit FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_version_edit_read ON spi.saved_version_edit FOR SELECT USING (true);
CREATE POLICY saved_version_edit_write ON spi.saved_version_edit FOR ALL
    USING (spi.acting_role() IS NULL OR spi.acting_role() = 'ADMIN'
           OR (mode IN ('S', 'C') AND spi.may_edit_scheme(product)))
    WITH CHECK (spi.acting_role() IS NULL OR spi.acting_role() = 'ADMIN'
                OR (mode IN ('S', 'C') AND spi.may_edit_scheme(product)));

ALTER TABLE spi.saved_version_layout ENABLE ROW LEVEL SECURITY;
ALTER TABLE spi.saved_version_layout FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_version_layout_read ON spi.saved_version_layout FOR SELECT USING (true);
CREATE POLICY saved_version_layout_write ON spi.saved_version_layout FOR ALL
    USING (spi.may_edit_scheme(scheme_key)) WITH CHECK (spi.may_edit_scheme(scheme_key));

-- With two logins, the app's login reads users and records logins and audit events; users and grants are changed
-- only by the owner's login (python -m app.auth_user). With one login for both, it owns these and the step is skipped.
DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spi_app') THEN
        REVOKE INSERT, UPDATE, DELETE ON spi.app_user, spi.user_scheme FROM spi_app;
        GRANT UPDATE (last_login_at) ON spi.app_user TO spi_app;
        REVOKE UPDATE, DELETE ON spi.audit_log FROM spi_app;
    END IF;
END
$grants$;
