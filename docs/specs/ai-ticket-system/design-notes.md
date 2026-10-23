# AI 工单系统学生设计练习

先用自己的话写出设计，允许查资料，中文字段与草图都可以。导师或 AI 给出评审意见后，保留初稿、修订和修改理由，再让 AI 辅助实现。下列位置由学生逐阶段填写。

## 当前有效状态

2026 年 10 月 11 日：S1-B 代码专项、本人 A/B/越权实践回报和理解已通过，但正式 `docs/student-submissions/S1-B.md` 尚未提交，整项不勾选。S2-A 已完成导师准备并应用 003 工单迁移，负责人原子分配 foundation 专项通过，学生状态规则待实现。

学生更正实际投入为 4 小时，还剩 20 小时，先前时间口误以此次更正为准。身份授权与学生查询实践安排两小时，工单核心接口、事务和幂等安排三小时。按下文最新分工，导师完成框架和重复实现，学生先写核心函数，集中讲解后亲自验证；不再反复逐字段问答。管理配置先用 seed，RAG 四小时及最后一小时主链路复盘保留。目标是训练 MVP 和关键技能验证，不能将 24 小时等同于全面掌握或公司推广就绪。修订预算见 plan.md，验收状态保持不变。

## 主流程教学与手写分工的最新修订

学生指出仅由 AI 实现、学生不写代码，不能验证转型能力；随后明确要求每阶段给清楚双方职责，24 小时先教会整个主流程，再给深入分支。当前采纳：导师负责框架、标准库接入、迁移、重复接口/页面和测试工具，学生先写契约明确的核心函数，导师评审后接入并由学生亲自正反例。没有学生第一版不提前填本题完整答案；需要示范时记录帮助，再做变化题，不标为独立完成。

分工、函数输入输出、分钟预算及验收见 [learning-tasks.md](../../../../ai-ticket-system/docs/learning-tasks.md)。当前任务为 SystemsService.listAuthorizedSystems；S1-A 辅助完成已登记，S1-B 学生查询与个人实践保持待办。最后一小时学生演示自助解决与转人工后解决、知识审核入库两条闭环。深入分支及后续起步路线见 [branches.md](branches.md)，继续服务用户的公司推广与杭州/苏州/西安转型目标，不把薪资、录用或全面掌握作为已达成事实。

学生进一步要求操作层面的职责：导师实施要有提示词，学生代码要有正式任务与交付物，完成后要有查验入口。本轮补 [course-workflow.md](../../../../ai-ticket-system/docs/course-workflow.md) 的准备/查验模板及 14 项入口、S1-A 正式卡片、交付模板与任务状态。当前导师增加 verify:student:s1a 专项工具；语法检查退出 0、作业缺失预检退出 2、独立进程的错误替身被拒绝退出 1且本次测试库清理。学生源码未代写，正向角色查询/调用链及本人理解仍待交付后验证。预算保持已投入 4、剩余 20 小时。

学生指出 S1-A 直接列函数要求，未先说明要实现的功能。本轮先修订该卡：先说明登录/当前身份返回数据库角色、账号页的预期表现，以及已有直接查询和本次学生提取接入的区别，再说明表关系、调用过程、函数要求与验收。通用下发模板和总计划同步采用“功能在前、实现要求在后”，后续任务沿用；本轮未代写学生代码，未提前实现后续模块，验收状态与 4/20 小时预算保持不变。

学生要求后续任务也采用 S1-A 的功能说明方式。本轮实际编写 S1-B 至 S9-A 共 13 张完整卡片及索引，全部 14 项先讲功能/场景/结果，再给调用链、导师与学生职责、实现要求、预期、交付和准备/查验提示词。子任务预算合计 1200 分钟，仍包含讲解/手写/实践/查验，RAG 四小时与最后一小时保留。仅编写文档，未实现未来业务模块或代写学生核心代码；后续框架、准确类型和专项入口待导师逐题准备，学生验收仍待办。

## S1-A 最终查验与 S1-B 准备记录

学生提交实际 getUserRoles/currentUser 代码，导师源码审阅并依次 typecheck、build、verify:student:s1a、verify:auth，原生退出均为 0，未代修学生源码。查询按用户参数绑定、返回全部角色数组并排序；登录与 JWT authenticate 经 currentUser 真实调用。学生先说明 login/currentUser 返回角色用于登录与前端展示，补讲后又说明刷新经 JWT 守卫、凭据验证、当前用户到角色，基本理解通过。

本人先回传“我已经验证没啥问题”，在单个具体浏览器问题后回答“管理员和普通提交人，到期后退出登录”。这符合 demo_admin 的两角色与原一小时凭据失效规则；没有提供逐条个人命令退出码/刷新前后 exp 值，不代填。me 不续期由导师 verify:auth 工程验证证明。接受源码与当前对话交付，S1-A 通过但明确为获得过完整函数示范、接入提示与补讲的辅助完成，不记录独立实现整套认证。详细证据见 [查验记录](../../../../ai-ticket-system/docs/student-reviews/S1-A-2026-10-09.md)。

随后导师只准备 S1-B：新增 business_systems、company_systems、issue_types、system_issue_team_routes，复用团队/成员表；授权的 (company_id, system_id) 唯一，路由的 (system_id, issue_type_id) 唯一，team_id 可复用。依真实公司/系统访问检查和团队反查配置索引，未声称做过性能基准。可重复 seed 补客户 B、负责人、CRM/ERP、三分类、两团队、四授权六路由四成员；A 只获 CRM，B 只获 ERP，内部企业获两者。普通角色/管理员都不能通过角色跳过企业系统授权。

SystemsModule/Controller/Guard、系统选择页面、独立系统访问检查和问题分类接口已接入；/systems 不接受客户端公司参数（400），/issue-types 未授权系统 403。学生 listAuthorizedSystems 签名和调用位置冻结，查询保留 TODO、接口 501，不用伪造列表代替实现。

导师 typecheck/build/基础专项与原认证/角色/健康回归均为 0；现有项目 migrate 首次应用 002、重跑跳过 2，系统 seed 重跑各计数 0。学生专项预检原生 2、仅进程内错误 [] 替身原生 1，证明待提交与拒绝错误；本次测试库/API 已清理。001、vector 初始化、Compose、学生 AuthService 前后哈希一致，原数据库卷保留，锁文件/技术栈未更换。详细记录见 [2C 证据](../../../../ai-ticket-system/docs/stage-2c-verification.md)。

本轮正式下发 [S1-B](../../../../ai-ticket-system/docs/tasks/s1-b.md)：先明确 A/B 使用场景与结果，再列两表字段、认证公司来源、唯一改动函数、真实三条验证命令、本人浏览器/越权操作、交付与查验提示词。学生 SQL、正向专项及理解尚未通过，整个 S1 和后续工单/AI/RAG 保持待办。最新个人总投入仍为 4 小时，RAG 四小时与最后一小时复盘不挪动。

以下按教学先后保留原稿；其中旧单角色 SQL、Express 初期方案、“下一步”及当时尚未建项目的描述均为历史上下文，不能当作当前执行指令。当前规则以 spec.md、plan.md、schema-identity.sql 及应用版本化迁移为准，具体第二阶段任务见实际项目 docs/stage-2.md。

当前设计已确定：用户多角色、人员多部门、角色权限预设、负责人派单、草稿/附件 ID 返回顺序、一份草稿最多一张工单、未成功时一分钟后手动重试，以及建单与站内通知整体提交或回滚。业务功能仍须真实实现和验收；本记录不等同于完整数据库阶段完成。

## 2A 学生约束验收记录

学生最初把引用不存在角色的报错归因于 NOT NULL；经区分后，确认即使后端漏检，REFERENCES 仍能阻止不存在角色的引用，并主动补充后端也需要验证角色存在。联合唯一题中，学生说明 (8, 2) 与已有 (8, 1) 组合不同、可成功写入，并确认再插入 (8, 1) 不能成功。一个外键和一个联合唯一约束的讲解验收通过；随后学生回传亲自执行结果：迁移应用 0、跳过 1；schema_migrations 一条 001 / 001-identity.sql；roles 三条 1/requester/普通提交人、2/ops/运维人员、3/admin/管理员。结果符合预期，2A 学生验收完成。

## 实体和关系

学生先提出 JWT 认证，教师建议配合数据库会话撤销以满足原先退出立即失效的要求。学生随后明确：“现阶段不做任何的处理，原会话保留，token 失效时通过时间控制的，不做其他的处理。”再确定有效期“一小时”。2B 已按后续决定实现 JWT 3600 秒，不查 sessions、不删除或撤销任何后端会话，不新增会话表或黑名单；原 token 到期前仍可通过认证，me 不续期。HttpOnly Cookie 沿用。工程和浏览器验证完成，主动退出处理留作后续分支，学生亲自登录刷新待验收。

根据企业、提交用户、业务系统、运维团队和工单的实际业务，写出需要保存的对象以及一对多、多对多等关系。说明采用该关系的原因。

学生原配置草案：部门、部门负责人；进一步提出问题分类作为分派依据。

已确认业务决策：管理员通过配置管理分派，规则采用“所属业务系统与问题分类 → 运维团队”。本轮练习中的部门指运维团队。部门负责人属于团队自身信息，分派配置需要表达系统、分类与团队之间的关系。

学生第二轮配置草案：所属系统、问题分类、部门、部门负责人。

学生业务补充：部门可按公司层级统一组织，例如将前端人员放入统一前端组，负责多个系统的前端问题。

教师评审建议：分派配置关联 system_id、issue_type_id、team_id；部门负责人属于 teams 的信息，建议用 leader_user_id 关联用户。一个部门可以负责多条规则，负责人变更时只更新部门记录。此建议待学生理解后修订。

教师补充：每条分派配置将系统与问题分类关联到一个团队，多个配置可以引用同一个 team_id。变更某条规则的负责组时更新该配置的 team_id；团队的名称与负责人在 teams 中维护。客户 company_id 表示工单客户归属，公司统一运维组不会合并客户数据或自动授予访问权限。建议对 system_id 与 issue_type_id 设置必填和联合唯一约束，具体 SQL 待下一步练习。

配置记录的主键、外键和组合唯一性约束由学生继续设计。

学生关联校验方案：管理员配置时只能选择已有团队，插入配置前检查团队表中是否存在对应记录。

学生第三轮字段草案：

| 字段 | 学生说明的用途 | 是否必填 | 关联 |
| --- | --- | --- | --- |
| 所属系统 | 关联问题模块 | 是 | 系统表 |
| 问题分类 | 关联问题所属类别 | 是 | 问题分类表 |
| 部门 | 确定问题归属部门 | 是 | 部门表 |
| 部门负责人 | 问题归属部门后的问题分派 | 是 | 人员表 |

教师评审：前三项作为分派配置的 system_id、issue_type_id、team_id，均为必填外键。部门负责人信息由部门表的 leader_user_id 关联人员表维护；工单的具体处理人由工单表的 assignee_user_id 保存。

学生确认选择 A：工单归属部门后，由部门负责人指定成员。普通成员不能自行认领。负责人身份、工单访问权限和目标成员的部门归属由后端检查。

学生确认处理人字段选择 A：工单刚创建、负责人尚未指定成员时，assignee_user_id 保存 NULL，字段允许为空；部门负责人不会自动成为处理人。指定成员后保存该成员的用户 ID。

学生确认状态时机选择 A：负责人指定成员成功时，工单立即由 pending 进入 processing，无需成员再次点击开始处理。教师实现建议：处理人、状态、操作历史与通知同事务保存；首次分配的原子更新限定原状态为 pending 且处理人为空，避免并发覆盖。下一步由学生提出部门表字段草案。

学生部门表初稿：部门 ID、名称、负责人。

教师字段整理：teams.id 为部门主键；teams.name 保存部门名称；teams.leader_user_id 通过外键关联 users.id，保存负责人身份。此处只确认字段与关联方向，字段类型等实施细节后续确定。下一步确认同一个运维人员是否可以属于多个部门，以决定成员关系如何设计。

学生确认成员关系选择 A：同一个运维人员允许同时属于多个部门。部门与人员为多对多关系，采用独立部门成员关联表 team_members，每条记录表达一个人员属于一个部门。负责人分配工单时，根据该表检查目标人员是否属于工单部门。下一步由学生提出关联表字段草案，再讨论外键与组合唯一约束。

学生部门成员关联表初稿：表 ID、部门 ID、人员 ID、部门名称、人员名称。

教师评审建议：当前关联表保存 id（主键）、team_id（关联 teams.id）、user_id（关联 users.id）；部门名称和人员名称在查询时通过关联主表取得，页面可以展示，不重复保存到成员关联表，避免改名后多处更新不一致。本表用于表达当前成员关系；历史姓名或部门名称快照属于另外的业务需求。下一步由学生确认同一 team_id 与 user_id 的组合是否允许重复，以确定组合唯一约束。

学生确认成员记录唯一性选择 A：同一部门与同一人员的组合只能出现一次。team_members 采用 UNIQUE (team_id, user_id)，两个关联字段均必填且设置外键；team_id 或 user_id 单独出现重复值是允许的。

下一步 SQL 练习：学生尝试编写 team_members 的 PostgreSQL 建表语句，包含 id 主键、两个必填外键和联合唯一约束。练习暂定 teams.id 与 users.id 均为 BIGINT，关联表 id 可用 BIGINT GENERATED ALWAYS AS IDENTITY；这是教学假设，正式迁移须与最终主表类型一致。先提交学生草案，再由导师解释、修订和验证。

学生 SQL 初稿：

```sql
CREATE TABLE team_members (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, team_id BIGINT NOT NULL REFERENCES teams(id), users_id BIGINT NOT NULL REFERENCES users(id))
```

教师评审：自增主键、两个必填字段和外键写法正确；缺少已确认的部门与人员联合唯一约束。users_id 是合法列名，但建议统一为设计中的 user_id，表示单个人员的 ID。以下为评审修订稿，仅作教学记录，尚未在数据库执行；执行前需要存在主键类型兼容的 teams、users 表。

```sql
CREATE TABLE team_members (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id BIGINT NOT NULL REFERENCES teams(id),
    user_id BIGINT NOT NULL REFERENCES users(id),
    UNIQUE (team_id, user_id)
);
```

下一步练习：学生编写 teams 部门表的建表语句，沿用部门 ID、名称、负责人三个字段的设计；ID 为 BIGINT 自增主键，名称与负责人必填，负责人关联 users.id。

学生部门表 SQL 初稿：

```sql
CREATE TABLE teams (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name VARCHAR(100) NOT NULL, leader_user_id BIGINT NOT NULL REFERNCES users(id))
```

教师评审：三个字段、必填和关联方向正确；REFERNCES 拼写应为 REFERENCES。修订稿如下，尚未在数据库执行：

```sql
CREATE TABLE teams (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    leader_user_id BIGINT NOT NULL REFERENCES users(id)
);
```

建表依赖：users 必须先于 teams，teams 与 users 必须先于 team_members；用户所属企业若用外键关联，则 companies 还应先于 users。下一步由学生提出 users 的业务字段，考虑登录、姓名展示与所属企业；负责人身份已经由 teams.leader_user_id 表达，部门成员资格由 team_members 表达。

学生用户表字段初稿：ID、用户名称、登录名称、加密后的密码、所属部门 ID、角色 ID、所属公司 ID、人员类型、邮箱、手机号等。

教师评审建议：

- id 为用户主键；用户名称可命名 display_name，用于展示；登录名称可命名 login_name，用于账号登录，唯一性规则在登录契约中确定。
- 密码字段命名 password_hash，使用专用密码哈希算法保存带盐的密码哈希，不保存明文或可逆加密的密码。
- 已确认用户可以属于多个部门，因此成员关系由 team_members 保存，users 不以单个 department_id 表达全部部门归属。
- role_id 表示权限角色，若采用角色表则通过外键关联。部门负责人的资格已经由 teams.leader_user_id 表达；人员类型的业务含义待学生确认，不能直接等同于权限角色。
- company_id 关联 companies.id，表示用户所属企业。邮箱 email 与手机号 phone 可作为联系方式，必填与唯一规则需结合登录方式决定。

学生确认人员类型选择 A：区分内部员工和外部客户。与 role_id 的权限职责分开；内部员工身份本身不授予运维或管理权限。字段草案可用 user_type 表达 internal、external。公司表结构尚未确定，若最终公司属性可以完整推导人员类型，实施评审时再考虑从公司信息推导，避免两处维护不一致。

学生确认登录名唯一范围选择 A：登录名全平台唯一，登录使用账号和密码，无需输入公司标识。login_name 设置 NOT NULL UNIQUE，公司归属由登录成功后的用户记录确定。

下一步用户表 SQL 练习：按 id、display_name、login_name、password_hash、company_id、role_id、user_type、email、phone 编写建表草案。沿用学生 role_id 草案，第一版先按单角色建模；教学参考采用 BIGINT 自增主键，company_id、role_id 分别关联 companies.id、roles.id，假设两者均为 BIGINT 主键。人员类型使用 CHECK 限定 internal、external；密码哈希用 TEXT。教师建议邮箱与手机号第一版选填，其余字段必填。关联主表和完整建表顺序在实际执行前补齐，此时仍只进行 SQL 草案练习。

学生用户表 SQL 初稿：

```sql
CREATE TABLE users (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY ,display_name VARCHAR(100) NOT NULL , login_name VARCHAR(100) NOT NULL UNIQUE,password_hash TEXT NOT NULL,company_id BIGINT REFERENCES companies(id),role_id BIGINT REFERENCES roles(id),user_type BIGINT NOT NULL CHECK （user_type IN (‘internal’,'external')）,email VARCHAR(254),phone VARCHAR(32))
```

教师评审：主键、展示名、唯一登录名、密码哈希与联系方式的写法符合练习要求。需修正三处：company_id 和 role_id 补 NOT NULL（外键不会自动禁止 NULL）；user_type 改为 VARCHAR(20)，与 internal、external 字符串取值一致；CHECK 的中文全角括号和弯引号改为 SQL 半角括号与单引号。修订稿如下，仅作教学记录，尚未在数据库执行：

```sql
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    login_name VARCHAR(100) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    company_id BIGINT NOT NULL REFERENCES companies(id),
    role_id BIGINT NOT NULL REFERENCES roles(id),
    user_type VARCHAR(20) NOT NULL
        CHECK (user_type IN ('internal', 'external')),
    email VARCHAR(254),
    phone VARCHAR(32)
);
```

下一步由学生提出 companies 公司表的最小业务字段，再补齐 roles 等建表依赖，之后进入实际执行与约束验证。

学生公司表字段初稿：ID、名称、地址、公司法人名称。

教师评审：将“公司法人名称”按通常业务意图整理为法定代表人姓名 legal_representative_name。公司 ID 为主键，名称必填；地址和法定代表人姓名建议第一版选填。公司名称暂不设置唯一约束，公司身份通过 id 区分。依据学生字段设计生成以下教学 SQL，尚未在数据库执行：

```sql
CREATE TABLE companies (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    address TEXT,
    legal_representative_name VARCHAR(100)
);
```

下一步由学生提出 roles 角色表字段，随后整理 companies、roles、users、teams、team_members 的完整建表顺序并验证约束。

学生角色表字段初稿：角色 ID、角色名称、权限列表、用户 ID 列表。

教师评审建议：角色 ID 为主键，名称用于展示；可增加唯一且稳定的 code 作为业务标识。权限列表表达角色可执行的操作，第一版建议使用预定义权限码，例如 ticket:create、ticket:process，由后端验证；实际存储方式待权限范围确定。权限码还需与工单归属、团队成员资格及负责人身份等数据范围检查共同使用。

用户 ID 列表不重复保存在 roles 中：按当前 users.role_id 设计，一个角色对应多个用户，查询 users.role_id 即可取得这些用户；若用户需要多个角色，则改用 user_roles 关联表，并相应修订 users.role_id。当前单角色只是此前 SQL 练习的假设，下一步由学生明确业务选择。

学生确认选择 B：一个用户可以拥有多个角色。正式设计改为 users 与 roles 多对多，通过 user_roles 保存关系；移除 users 建表草案中的 role_id，roles 也不保存用户 ID 列表。上方含 users.role_id 的 SQL 保留为历史练习，不再作为当前建表版本。

当前用户表 SQL 草案（尚未执行）：

```sql
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
```

用户角色关联表复用已学习的部门成员表结构，两个必填外键及联合唯一约束如下（尚未执行）：

```sql
CREATE TABLE user_roles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    role_id BIGINT NOT NULL REFERENCES roles(id),
    UNIQUE (user_id, role_id)
);
```

教师实现建议：多个角色的操作权限合并；每次操作仍验证企业、工单和团队等数据范围。创建用户及其初始角色关联在同一事务保存，后端检查至少指定一个有效角色。下一步确认第一版权限组合是由代码预设、管理员仅分配角色，还是允许管理员调整各角色的权限。

学生确认权限管理选择 A：第一版预设各角色的权限，管理员只给用户分配角色。roles 保存 id、code、name；code 唯一，用于后端固定权限映射，名称仅用于展示。权限列表不保存到角色表，用户关联通过 user_roles 查询。预设 requester、ops、admin 三种角色。

导师已将当前六张基础表及预设角色整理到 schema-identity.sql。建表顺序为 companies、roles、users、user_roles、teams、team_members；整份教学迁移使用单个事务。下一步在隔离的学习数据库中执行并验证唯一、外键、CHECK 及多对多关系，再由学生亲自完成关联查询。

2026-10-08 导师验证结果：使用本机已有 postgres:16-alpine 镜像，启动无网络、无端口映射、数据保存在临时内存文件系统的独立容器。通过 psql -X -v ON_ERROR_STOP=1 -f /tmp/schema-identity.sql 执行成功，建立六张表并插入三个角色。随后事务内验证同一用户拥有两个角色、加入两个部门成功；重复角色关联、重复部门成员、关联不存在的角色、重复登录名、空公司 ID、非法人员类型六种写入均被对应约束拒绝。测试数据事务回滚，临时容器已清理。此结果只验证基础教学迁移和约束，不代表登录、权限接口或完整应用已实现。

下一步学生练习：假设存在登录名 zhangsan，编写 SQL 查询其全部角色名称，使用 users、user_roles、roles 关联；先由学生提交查询草案，再评审 JOIN 条件。

学生关联查询初稿：

```sql
select r.name form roles r JOIN user_roles ur ON ur.role_id==r.id JOIN users u ON u.id==ur. user_id WHERE u.login_name=='张三'
```

教师评审：表关联路径和关联字段正确。从 roles 开始进行 INNER JOIN 同样可以完成查询。需将 form 修正为 FROM，PostgreSQL 相等比较使用 =；本题筛选的登录名为 zhangsan，应使用该值。字符串“张三”本身合法，但只有实际登录名为该值时才符合筛选条件，不能与 display_name 混用。修订查询如下，本轮仅评审语句，未重新执行数据库验证：

```sql
SELECT r.name
FROM roles AS r
JOIN user_roles AS ur ON ur.role_id = r.id
JOIN users AS u ON u.id = ur.user_id
WHERE u.login_name = 'zhangsan';
```

下一步回到工单创建主链路：由学生提出 POST /tickets 创建接口的前端请求字段草案，结合此前工单业务字段，区分客户端输入与服务端从登录身份及分派配置得到的数据。之后评审并完善工单表、接口契约及事务范围。

教师补充的数据库约束：前端选择与后端查询保留，数据库通过外键保证 team_id 引用存在的 teams.id；system_id 与 issue_type_id 同样关联其主表。三个关联字段必填，system_id 与 issue_type_id 联合唯一，team_id 可重复。学生在“CRM 的另一种分类可以引用同一团队”的例子中确认无需阻止该记录，完整字段草案待学生整理。

评审后修订及理由：待填写。

## 工单字段

先回答：一张正式工单需要保存哪些信息，才能确定由谁提交、属于哪个客户、涉及哪个系统、由谁处理，以及当前进度？先写业务信息，再考虑字段类型。

学生初稿：用户的身份、问题的类型、问题描述、紧急程度、文件附件、创建时间、完成时间、工单状态、是否解决、解决人、是否进入知识库、知识库对应数据 ID。

学生补充：增加所属客户字段，保存客户公司的 ID。创建工单时根据用户 ID 查询所属企业。

教师补充：用户 ID 从服务端验证的登录身份获得；查询企业后将用户与企业归属保存到工单。公司字段建议命名 company_id，并关联企业记录。

教师评审建议，待学生修订：

- 身份和问题类型需要关联相应记录，具体字段与类型在后续练习中确定。
- 第一版以工单状态作为是否解决的判断依据，避免独立维护两个可能矛盾的值。
- 完成时间在新建时为空；需要区分当前处理人、提交解决方案的人与用户确认。
- 多个附件采用独立关联记录；知识沉淀需结合审核状态与知识文档关联设计。
- 企业归属已补充，继续设计系统与分类的分派配置、主键、解决方案与处理历史。

学生创建工单请求初稿：用户 ID、问题所属模块、问题类型、附件、问题描述。

教师评审：

- requester_id 从服务端验证的登录会话取得，不由提交请求指定；company_id 从该用户记录取得。
- 问题所属模块沿用已确认的所属业务系统，映射为 system_id；问题类型为 issue_type_id；问题描述为 description。
- 附件先上传，请求传 attachment_ids，后端验证附件属于当前用户及当前草稿，并按问题类型检查截图或日志等材料要求。
- 补回学生先前提出的紧急程度 priority，第一版建议由用户选择并由后端校验允许值。
- 本流程经 RAG 和用户确认形成草稿，提交还需携带 draft_id，以验证草稿归属并关联咨询记录。客户端传来的系统、分类与内容需按提交契约校验后保存，不能直接信任已保存草稿或客户端数据。
- 团队由系统与分类配置查询，初始状态为 pending，处理人为 NULL，创建时间由服务端或数据库生成。

下一步学生练习：说明用户双击提交或网络超时后重试时，后端如何避免创建两张工单；原教学参考为 request_key，后续评审根据草稿业务采用更直接的 draft_id 唯一约束。

学生追问：前端如何取得工单草稿 ID，以及已上传附件的 ID 列表？

教师补充接口衔接：草稿 ID 由后端保存草稿后返回，无答案分支通过 SSE draft_ready 事件携带 draft_id，用户反馈未解决分支通过 POST /consultations/:id/feedback 的响应携带 draft_id。前端取得草稿 ID 后，再调用 POST /drafts/:id/attachments 上传文件；后端保存文件与附件元数据，返回附件 id、draft_id、name。前端收集成功上传的附件 ID，最终与草稿 ID 和表单字段一起提交 POST /tickets。GET /drafts/:id 返回表单和附件元数据，以支持刷新恢复。数据库主键由后端持久化流程产生，模型和前端不自行虚构这些 ID。完整响应契约示例已补入 spec.md，接口尚未实现。

学生确认采用上述草稿与附件流程，并强调数据库设计必须服务于原定 24 小时 AI 全栈训练。后续节奏调整为：收口幂等、事务等关键设计后，进入工程连通与接口实现；重复 DDL 和 CRUD 用 AI 辅助生成，保留学生对核心设计、修改和验收的参与。最终主链路复盘与深入分支仍保留在最后一小时。

学生防重复提交方案：点击后以模态显示正在提交，成功后关闭，失败保留已有表单内容；网络超时不自动重试，只允许用户手动点击。

教师评审：此交互用于减少前端误操作，保留手动重试选择。补充“数据库提交成功但响应丢失”的场景：前端超时并不能判断后端失败，手动重试也可能重复建单。第一版建议一份草稿最多一张工单，以 tickets.draft_id 的必填、外键和唯一约束防重。同内容重复提交返回原工单；事务中对草稿加行锁，处理并发；已建单后内容不同返回冲突及原工单 ID，不能误报修改成功。通用 request_key 作为后续扩展，不增加第一版前端字段。

下一步学生练习：若工单记录插入成功，而同次操作的站内通知记录写入失败，应如何处理已经写入的工单？借此收口数据库事务的业务含义。

学生补充防重要求：后端应识别重复工单提交，一分钟内不允许重复，一分钟后可以再次提交。

教师评审待澄清：一分钟防重复窗口与同一次提交的重试幂等是不同规则。若首次建单成功但响应丢失，用户在超过一分钟后重试，单纯按时间窗口放行仍会创建重复工单。需确认“一分钟后可以”表示重新发起一张工单（新草稿），还是同一份草稿再次提交也可以生成新工单。前面的 UNIQUE(draft_id) 是教师提出的第一版建议；该业务语义澄清前不将其作为最终确认约束，也不据此创建工单表。建单事务问题暂待该澄清之后继续。

学生进一步明确：同一份草稿支持超过一分钟后再次提交，但如果上一次已经生成工单 ID，第二次不能再生成新工单。由此确定一份草稿最多成功创建一张工单，一分钟约束只控制尚未成功时的再次创建尝试。

教师实现整理：已有工单则返回已提交及原工单 ID，前端应区分新建成功与已存在，不能误报新建了第二张。没有工单且到达一分钟间隔后可手动重试；原请求仍在处理中时不并行再创建。唯一约束与草稿行锁负责最终防重，后端时间校验负责重试间隔。重试间隔记录需独立于建单事务保存，以免业务回滚清除了间隔限制。继续待回答的问题是建单成功写入后，同次站内通知写入失败应如何处理。

学生事务判断：追问为什么会出现工单写入成功而站内通知记录失败，并要求通知记录失败时，本次工单不能写入成功。

教师解释与设计收口：工单 INSERT 与通知 INSERT 是两条数据库语句，第一条执行成功不代表包含它们的事务已经提交。例如工单字段合法，通知记录遗漏必填接收人字段，第二条会被数据库约束拒绝。应在同一数据库连接中 BEGIN，将工单、团队分派、操作历史和站内通知记录作为一个事务写入，全部成功后 COMMIT；任一写入失败则 ROLLBACK，本次不留下新工单和其他部分成功的业务记录。业务回滚保留此前已经存在的草稿和已上传附件，并保留独立的重试间隔记录。

失败边界：上述回滚针对数据库业务事务未提交时的写入失败。若通知记录已成功提交，仅页面轮询、展示或 HTTP 响应失败，则恢复查询已有结果，不撤销已提交工单；此前的幂等重试规则用于这个场景。接口应在 COMMIT 成功之后才返回新建成功。

当前练习任务：2A 六表迁移、角色 seed、约束讲解及学生亲自执行全部通过；下一项为 2B 登录、会话与多角色，尚未实现。工单、AI 与业务接口仍待对应阶段实现。

| 学生提出的字段 | 业务用途 | 类型与是否必填 | 关联或约束 |
| --- | --- | --- | --- |
| 待填写 | 待填写 | 待填写 | 待填写 |

评审后修订及理由：待填写。

## 查询与约束

写出用户查看我的工单、运维查看团队待办、客户隔离、重复提交和负责人并发分配的查询或约束需求。依据查询说明哪些字段需要索引，哪些约束应由数据库保证。

学生初稿：待填写。

评审后修订及理由：待填写。

## 接口和状态

为正式提交设计请求、响应、权限、失败与重试行为；为工单状态变化写出原状态、操作者、条件与目标状态。圈出必须同事务保存的数据。

学生初稿：待填写。

评审后修订及理由：待填写。

## AI 和知识检索

画出入库、查询、生成、解决反馈和草稿的数据流。说明来源和授权信息在哪里保存、检索时怎样生效、技术失败怎样区别于缺乏知识。

学生初稿：待填写。

评审后修订及理由：待填写。

## 附件和部署

说明附件怎样关联草稿与工单、谁可以访问；画出部署连接、持久化、备份和恢复顺序。

学生初稿：待填写。

评审后修订及理由：待填写。

## 需求变化与独立验证

记录一个新需求、涉及的数据关系与接口变化、修改理由、实际实现和验收结果。

学生初稿与验证：待填写。


## 2026-10-15：S3-A 完成确认与 S3-B 下发

用户明确说明 S3-A 已完成并要求标记完成、进入下一项。本次依历史 Responses 真实请求、受控 HTTP 错误/取消通过补记及本人确认登记；单独交付文件不再追补，不伪造学生运行或理解原始记录。

S3-B 冻结四个允许字段：description、issue_type_code、urgency、reproduction_steps。导师只准备类型/异常/占位、006 咨询草稿唯一外键、工具声明与一次调用/白名单、结构化与 Responses 工具入口、后端可信身份与授权持久化、草稿查看修改页和专项。学生仅实现 parseDraftProposal 的 JSON/Zod 严格校验，未代写。模型和客户端不能指定公司、系统、权限、处理人或正式建单。草稿、咨询状态、draft_ready 同事务保存，已有草稿重试返回原 ID。

实跑类型、全栈构建、foundation、S3-A 框架/S2-B/认证回归均为 0；006 迁移首次和重复均为 0；学生专项 2（占位）。真实工具探测 1，HTTP 503；受控替身不冒充真实能力，主线先用结构化输出。S3-B 学生项与整个 S3 阶段保持待办，最后一小时复盘预算保留。

## S3-B 本轮验收补记

S3-B 主线已通过（导师辅助完成）：JSON/Zod 严格校验已接入真实 HTTP/数据库链路，typecheck、build、verify:s3b:foundation、verify:student:s3b 均退出 0；学生已正确解释额外字段导致整份拒绝，并回报真实页面已能进入草稿、点击保存，明确要求本题验收通过。未单独提交交付文件，以当前对话为交付。保存成功提示/刷新后持久化尚未由本人明确确认；不将其补写为通过证据。原生工具调用、逐段流式及“已解决”闭环仍待后续验证。下一任务 S4-A，导师尚未准备，不提前实现。

保存草稿只 PATCH 已有草稿，成功提示应为“草稿已保存，尚未生成正式工单”，不跳转、不建正式工单。导师修复模型错误映射，503 无新增草稿断言通过；学生核心源码未改。

## S4-A 导师准备与维度契约

S3-B 本人已明确确认页面验证通过，作为前置主线验收，不再追补交付文件。S4-A 工程准备完成，学生 retrieveKnowledge 的权限/排序 SQL 未填。真实 Embedding 缺配置：007 使用 vector 加 vector_dims 检查和 profile/维度复合外键，实际首份导入再冻结真实维度，避免猜 1536。配置 key 由地址与模型名哈希，不含密钥；切换配置不混查。小样本精确余弦检索，不新增近似索引。

五份虚构资料、事务导入、重复跳过、失败回滚、校验与知识检索 API、咨询开关和独立专项已准备。typecheck/build/foundation/S3-B/认证回归均 0，学生专项 2（占位），真实 probe 1（EMBEDDING_CONFIG_MISSING）；007 首次/重跑 0/0，原卷/vector 保留，受控向量不写项目库。KNOWLEDGE_ENABLED 默认 false，学生专项和真实导入通过后才开启；不因后端500/向量503而伪装无知识。

S4-B 仍未准备，不代写引用校验/反馈。预算保持 S4-A 150 分钟和 S4 总 240 分钟，最后一小时复盘保留。

## 本地 Embedding 实际接入

本地真实 Embedding 已接入：地址 http://127.0.0.1:8000/v1，模型 google/embeddinggemma-2；两次真实响应 HTTP 200，768 维有限非零向量。knowledge:probe=0；knowledge:import 首次=0，五份虚构文档导入；重跑=0，五份全部跳过。仅更新 api/.env 的三个 EMBEDDING_* 键，未改生成模型配置；本地接口当前无需鉴权，API_KEY 使用无鉴权占位 local-no-auth（不提供身份验证能力）。学生 retrieveKnowledge 未改、仍为占位；真实检索、换问法和本人实践未验收，KNOWLEDGE_ENABLED 继续保持默认 false。

## 切片风险实证与评测基线

用户要求先验证再安排优化。实际函数将构造长段切为800/18字符，内容可拼回，但动作/条件不在同片；库内11片中5片纯标题。新增eval:rag只读评测与逐题报告（不调用生成模型）：真实本地Embedding，4可回答+1无资料开发题，topK1 Precision=1、证据Recall=.75；topK3 Precision=.4167、证据Recall=.875，权限违规0；无资料题仍返回1/3候选。基线不代表总体准确率。保留算法与学生代码；后续结构切片/重叠/扩展、语义切片对照和质量回归已纳入原阶段及深入分支，见项目docs/rag-quality-plan.md。

## S4-B 当前交接（2026-10-15）

用户要求继续下一阶段。S4-A 学生SQL、真实检索/本人查询及理解已有证据；本人修改后重复导入仍待确认，不补写为通过。S4-B导师准备已完成：008来源快照/resolved、严格模型输出、来源校验真实调用、反馈/持久化草稿/恢复与UI。学生validateSourceIds仍占位。

- [x] S4-B导师准备：typecheck/build/foundation、S4-A/S3-B/认证回归均0；008首次/重复迁移0；原库/卷/vector保留。
- [ ] S4-B学生实现与专项：当前退出2（占位），后续断言待验。
- [ ] 本人真实三类问法、答案证据/条件核对、已解决及未解决/刷新同草稿、理解查验。

职责/数据/命令/样例见 [当前任务卡](../../../../ai-ticket-system/docs/tasks/s4-b.md) 与 [准备证据](../../../../ai-ticket-system/docs/stage-4b-verification.md)。S4-B90分钟、S4共240分钟预算不变，最后一小时复盘保留；切片/召回改进及扩大评测集保持待办，不勾整个阶段。工程准备不等于学生掌握。

## S4-B 最新本人实践确认

学生validateSourceIds已实现，typecheck/build/S4-B foundation/student及S4-A/S3-B回归均0，原学生源码保留。理解经提示通过。两个RAG开关已开启，后端已重启并健康；用户明确确认人工咨询验证通过、已解决刷新仍保留、再次进入草稿ID不变。

- [x] 引用校验代码专项及理解。
- [x] 本人真实咨询与已解决/未解决持久化恢复分支（当前对话证据）。
- [ ] 真实改写/无资料题、逐结论证据与条件保留的质量评测，尚无具体回传，不代填。

上述覆盖此前占位/未重启/实践未确认的历史状态；不勾整个S4，预算与最后一小时复盘保留。

## 进入S5-A（用户明确要求先推进主流程）

S4-B引用校验/理解/本人反馈闭环通过；咨询17无资料转草稿通过，咨询18改写误转人工是已记录质量反例，后续切片/召回/支持判断仍待改进，不标为已解决。按用户指令推进S5-A。

- [x] S5-A导师准备：009私有附件状态、真实上传/授权下载/失败清理、受限标准/材料预检、正式提交必经调用、草稿页及真实专项。typecheck/build/foundation与S4-B/S3-B学生、S2-B基础回归均0；原库/卷/vector保留。
- [ ] S5-A学生函数validateTicketMaterials及student-standard.json新增复现规则；学生专项当前2。
- [ ] 本人缺截图/缺日志/新增规则正反例和理解；S2-B完整HTTP回归在材料核心完成后运行，当前2。

具体[任务卡](../../../../ai-ticket-system/docs/tasks/s5-a.md)、[准备记录](../../../../ai-ticket-system/docs/stage-5a-verification.md)。S5-A50分钟与S5共120分钟预算不变，S5-B提交状态/重试尚未准备，最后一小时复盘保留。

## S5-B导师准备完成（2026-10-16，当前有效交接）

用户明确要求进入下一阶段。S5-A学生材料函数/新增配置专项和理解通过；本人截图齐全通过及缺日志拒绝已确认。缺截图/删除/其他个人实践未完整回传，保持待办，不补造或阻塞本次用户授权推进。

- [x] S5-A材料学生专项及S2-B完整HTTP回归均0；导师补齐010附件逻辑删除，原库/卷/vector保留。
- [x] S5-B导师准备：真实草稿页按钮/弹窗、稳定快照、单次请求/10秒超时、已提交PATCH分支/原单重试、冲突原工单ID、可运行foundation与student入口。
- [x] typecheck/build/verify:s5b:foundation/S5-A学生/S2-B回归均0。
- [ ] S5-B学生submitDraft：当前占位，verify:student:s5b退出2，后续编排断言待执行。
- [ ] S5-B本人等待/失败保留/手动原草稿重试/请求次数/刷新及理解查验。

准确学生位置调整为web/src/composables/useTicketSubmission.ts内submitDraft，现有DraftProposalView.vue直接调用；导师提供lib/ticket-submission.ts辅助。该调整为便于真实Vue状态与HTTP测试，不扩大作业。具体见[任务卡](../../../../ai-ticket-system/docs/tasks/s5-b.md)与[准备记录](../../../../ai-ticket-system/docs/stage-5b-verification.md)。S5-B70分钟计入原S5共120分钟；最后一小时复盘不变，不勾整个S5。S6-A尚未准备。

## S5-B主线通过，进入S6-A（2026-10-16）

用户亲自确认工单1成功关闭弹窗、原草稿重试显示原工单1、断网保留内容/附件、Online刷新恢复，并明确验证通过进入下一阶段。S5-B代码专项与理解通过，按导师辅助主线通过登记；未回传的本人精确命令/Network计数不补造，不据此勾整个S5。

- [x] S6-A导师框架：011沟通/审核关联迁移，队列/详情/沟通/通知/审核页面与API；同事务授权/分配/通知回滚与受控知识回流专项。
- [x] typecheck/build、S6-A受控foundation、S5-B/S2-A/S4-A/认证回归均0；011首次应用1/跳过10、重复应用0/跳过11。
- [ ] S6-A学生扩展现有AssignmentService：RETURNING、AssignmentResult与准确返回；当前专项2（旧void），后续断言未执行。
- [ ] 真实Embedding审核/检索与新咨询：本地8000无监听，probe连接失败，real专项1，不能用受控向量冒充通过。
- [ ] 学生跨账号处理/确认/重开、并发与通知回滚实践/理解。

原S2导师原子SQL保留，学生任务按已看示范后改写；不删除旧功能制造占位。导师修复既有transition SQL的42P08参数类型冲突，未改学生状态机/建单/材料/检索/引用/提交核心。知识审核固定原客户企业私有范围，人工编辑脱敏；文档/片段/审核关联同事务，已批准快照的撤回/版本留后续分支。

准确任务与证据见[任务卡](../../../../ai-ticket-system/docs/tasks/s6-a.md)、[准备记录](../../../../ai-ticket-system/docs/stage-6a-verification.md)。S6预算120分钟与最后一小时复盘不变，S7-A未准备。

## Embedding恢复与S6-A真实专项（2026-10-16最新）

初查127.0.0.1:8000为ECONNREFUSED。排查期间D:\AI\embedding-service的新进程启动，约66秒后就绪；start.ps1默认仅等15秒，启动提示不等于服务ready。旧进程退出原因现有日志不足以确定。当前health=ok、knowledge:probe=0（真实768维）、verify:s6a:knowledge:real=0，独立库真实审核/向量/关联/检索/企业隔离通过，原库/模型配置/向量未更改。学生RETURNING、本人与生成答案质量仍待验证，不勾整个S6。详见[诊断记录](../../../../ai-ticket-system/docs/embedding-diagnosis-2026-10-16.md)。

## 用户新增主动退出（2026-10-16）

已按用户明确要求补导航退出按钮及POST /auth/logout：受Origin保护，清Cookie、清前端身份并回登录；JWT仍按一小时到期，未新增sessions/撤销/黑名单。typecheck/build/verify:auth及导师真实浏览器退出/保护页拦截通过，原库/卷与学生核心保持。该变更覆盖此前不提供退出接口的阶段限制，不改变S6-A当前本人闭环待验状态，计入原阶段预算。见[验证记录](../../../../ai-ticket-system/docs/logout-verification-2026-10-16.md)。

## S6-A主线通过与S7-A导师准备（2026-10-16最新）

用户明确要求“这个阶段先通过，进入下一个阶段”。S6-A学生RETURNING、理解（提示后）、工单1跨账号补材料/方案/解决/重开/再次解决，以及demo_admin审核文档6的真实768维入库已有证据。按用户要求登记主线通过；正文dqqdqw、客户召回/答案依据及本人专项运行结果保留待补，不阻塞本次推进，也不伪造成全部质量通过。

S7-A已准备：evals/student-cases.mjs三个学生占位和s7-case-types.d.ts；独立真实PostgreSQL/HTTP/私有附件夹具；17导师例+3学生例固定评估；requestId/白名单日志；有意训练配置故障及实际debug报告。学生先写I01，专项支持--case I01，再写通知回滚、防重和本人排错。导师不代写三个场景或提前修训练JSON。未准备S8。

实际命令：typecheck/build、verify:s7a:foundation、verify:auth、verify:s6a:foundation、verify:student:s5b均0；verify:student:s7a（含I01单项）2；eval:s7为17通过/0失败/3待学生、退出2；debug:s7a为有意故障400/MATERIALS_REQUIRED、退出1，requestId连接HTTP与数据库回滚。首次导师D03预期误写409，核对现有403契约后只修测试，未改学生状态机。最后追踪补充后类型/构建/S7基础复测0。

本次受控模型不代表真实语义质量。所有本次独立随机库/API/临时附件清理，未改原工单/知识/卷/vector；无新依赖或迁移，JWT3600秒及退出清Cookie保持。S7仍120分钟，本人有效学习仍4小时，最后一小时复盘保留。任务与准备证据在实际项目docs/tasks/s7-a.md、docs/stage-7a-verification.md；本轮只勾导师准备，学生S7继续待办。
