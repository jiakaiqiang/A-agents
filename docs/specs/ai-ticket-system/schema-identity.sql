-- AI 工单系统：基础身份与部门关系教学迁移。
-- 在新的学习数据库中执行一次；已有同名表时应停止并检查，不覆盖原表。
-- 权限组合由后端根据 roles.code 预设，数据库只保存角色及用户角色关联。
-- 建表顺序遵循外键依赖，全部建表及角色初始化在同一事务中完成。
-- 2026-10-08：对应 DDL 已整理为实际项目 db/migrations/001-identity.sql 并应用。
-- 角色已分离至 db/seed/001-roles.sql，通过唯一 code 可重复执行。
-- 项目使用 NestJS + pg，由迁移执行器统一管理事务及版本；本文件仅保留教学依据。
-- 不要在已迁移的项目库直接重跑本文件，也不要追加到仅空卷启动时执行的 db/init。

BEGIN;

CREATE TABLE companies (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    address TEXT,
    legal_representative_name VARCHAR(100)
);

CREATE TABLE roles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL
);

CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    login_name VARCHAR(100) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    company_id BIGINT NOT NULL REFERENCES companies(id),
    user_type VARCHAR(20) NOT NULL
        CHECK (user_type IN ('internal', 'external')),
    email VARCHAR(254),
    phone VARCHAR(32)
);

CREATE TABLE user_roles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    role_id BIGINT NOT NULL REFERENCES roles(id),
    UNIQUE (user_id, role_id)
);

CREATE TABLE teams (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    leader_user_id BIGINT NOT NULL REFERENCES users(id)
);

CREATE TABLE team_members (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id BIGINT NOT NULL REFERENCES teams(id),
    user_id BIGINT NOT NULL REFERENCES users(id),
    UNIQUE (team_id, user_id)
);

INSERT INTO roles (code, name) VALUES
    ('requester', '普通提交人'),
    ('ops', '运维人员'),
    ('admin', '管理员');

COMMIT;

-- 后端后续还需验证：创建用户时至少分配一个预设角色；负责人和目标处理人
-- 符合部门及运维资格；操作满足企业、系统与工单访问范围。外键不代替授权。
