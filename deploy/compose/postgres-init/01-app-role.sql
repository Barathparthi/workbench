-- Runs once, on an empty data directory. The application logs in as qews_app_login, which has only the
-- qews_app group's rights (DML, append-only audit); migrations grant those rights to qews_app.
CREATE ROLE qews_app NOLOGIN;
CREATE ROLE qews_app_login LOGIN PASSWORD 'devonly-app' IN ROLE qews_app;
