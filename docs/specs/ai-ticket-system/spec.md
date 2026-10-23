# AI 工单系统业务与接口约定

> 当前工程进度（2026-10-16）：S6-A按用户指令主线通过，S7-A导师已准备并下发客户隔离测试。接口响应新增后端生成的X-Request-Id；错误体附同一requestId，白名单日志关联数据库/检索/模型步骤，不记录凭据或业务正文。原业务规则、数据库卷/vector和JWT3600秒不变。S6知识质量及S4评测缺口保留，旧阶段进度以下方历史为准，最新任务见实际项目docs/current-progress.md。

项目目标是在 24 小时有效学习时间内完成可演示、可解释、可复现的最小版本，再通过试运行补齐公司推广所需能力。使用 Vue 3、TypeScript、Element Plus、Node.js、NestJS、PostgreSQL 和 pgvector。第一小时用于需求和环境确认，后 23 小时用于开发与复盘。

## 当前工程与技术栈

实际源码在 D:\demo\ai-ticket-system。当前进入S4-B：S1身份/授权、S2状态/建单、S3模型/草稿及S4-A授权检索已有实现与专项证据；本地Embedding768维、五份资料已导入。S4-B导师准备完成，学生来源校验及真实答案质量仍待验。008已应用，原卷/vector保留；学生本人重复导入实践仍待确认。有效学习时长最近回报4小时，不按日历推算。详细当前状态见实际项目 docs/current-progress.md。

- 前端：Vue 3、TypeScript、Vue Router、Pinia、Element Plus、Vite。
- 后端：项目 Node 24.21.0、NestJS 12（默认 Express 适配器）、pg、Zod，保持现有 ESM / NodeNext。
- 数据与运行：PostgreSQL 16 + pgvector，Docker Compose 独立卷；npm workspaces 和根 package-lock.json。
- AI：第三方模型与 Embedding 接口在后端适配，SSE 向前端传输事件；本地Embedding已验证768维，真实逐段流式/工具能力和回答质量分别验收。

后续代码按 NestJS Controller、Service、Guard 与依赖注入组织，复用现有 DatabaseService；使用 pg 参数化查询，同一业务事务的语句使用同一个 PoolClient。Element Plus 提供表单和后台页面组件。系统全局 Node 20 与项目 Node 分开，通过项目 scripts/setup-node.ps1 启用后者。

教学执行以 [导师/学生分工与核心手写契约](../../../../ai-ticket-system/docs/learning-tasks.md) 为准。导师实现框架与重复代码，学生先写指定函数、接入真实链路并运行正反例；工程通过和学生掌握分开记录。24 小时完成并验收主流程后，再按 [深入分支](branches.md) 补公司试运行与求职能力。当前正式学生任务为 [S4-B](../../../../ai-ticket-system/docs/tasks/s4-b.md)，只实现本次检索来源ID归属校验并实践回答/反馈分支。

## 已确认的业务规则

- 同时服务内部员工和外部企业客户；客户企业下可以有多个用户，数据按企业隔离。
- 管理员维护企业与用户；20 小时剩余训练预算先用可重复虚构 seed，完整用户管理界面与邀请机制列为训练后扩展。
- 用户选择获授权的业务系统并描述问题，先检索有权限访问的知识资料。
- 有依据的答案展示来源，由用户选择已解决或未解决；已解决结束咨询，未解决进入草稿。
- 无有效知识依据时进入草稿。模型或检索接口故障需要记录技术失败原因，并提供转人工入口。
- 用户确认问题类型；按类型补齐日志、截图等材料。后端依据配置重新校验。
- 用户确认提交后正式建单，根据“所属业务系统与问题分类”的组合配置分派运维团队，并生成站内通知。配置由管理员维护。
- 工单归属团队后，由部门负责人指定具体成员处理；成员要求补充材料、提交解决方案，提交用户确认解决或重新打开。
- 可复用解决方案经管理员审核后进入知识库。

## 训练版范围

使用两个测试客户企业、一个内部企业、两个业务系统、两个运维团队、三种问题类型、五份 Markdown 或 TXT 文档。资料和账号使用虚构样例。

主链路页面包括登录、问题咨询、工单草稿、我的工单、工单详情、运维队列与通知。剩余预算内配置数据先用 seed；知识审核保留最小受权限保护的操作，完整管理表单列为后续分支。站内通知先轮询读取。

附件先保存到服务端私有目录并配置持久化卷；数据库保存元数据。工单标准采用受限的 JSONB 配置，界面问题要求截图、接口异常要求日志，第三种类型要求文字描述和复现信息。具体字段在开发任务中固定为样例，可后续调整。

知识检索先使用小数据集的精确向量检索。高级检索、PDF/OCR、可视化工作流、复杂配置设计器、外部通知和多 Agent 属于后续分支。

## 权限与角色

提交用户只能访问本人咨询、草稿、工单和相关附件，以及所在企业获授权的系统与知识。内部员工通过内部企业身份走相同提交流程。

人员类型区分内部员工与外部客户，权限角色区分可执行的操作。内部员工身份本身不授予运维或管理员权限，权限仍按服务端认证身份、角色与授权范围检查。

一个用户可以拥有多个角色，通过 user_roles 关联 users 与 roles。users 不保存单个 role_id，roles 不保存用户 ID 列表。user_roles 的 user_id、role_id 均为必填外键，并通过 UNIQUE (user_id, role_id) 防止重复赋予同一角色。角色的操作权限合并，具体操作仍检查企业、工单和团队范围；创建用户与初始角色关联在同一事务保存，后端要求至少指定一个有效角色。

第一版角色权限由后端预设，管理员只给用户分配预设角色。roles 保存 id、唯一 code 和显示名称 name，权限列表在后端按 code 映射。预设 requester（普通提交人）、ops（运维人员）、admin（管理员）；未知角色代码不授予权限。角色显示名称变更不改变权限映射。

| 预设角色 | 操作职责 | 仍需校验的数据范围 |
| --- | --- | --- |
| requester | 知识咨询、提交工单、补充材料和反馈解决结果 | 本人记录、所属企业与获授权系统 |
| ops | 查看团队工单、沟通、要求补充材料、提交解决方案 | 团队与系统授权；分派操作额外验证部门负责人身份 |
| admin | 管理企业、账号、用户角色、分派配置及知识审核 | 对应管理接口授权；处理工单仍按其运维角色和团队授权判断 |

登录名在全平台唯一，users.login_name 设置 NOT NULL UNIQUE。登录使用账号与密码，无需公司标识；登录成功后从用户记录确定所属企业。

运维人员通过团队和系统授权访问相关工单；其跨客户处理权限必须在后端显式检查。平台管理员管理配置、用户和知识资料。客户企业管理员属于后续扩展。

部门负责人由 teams.leader_user_id 关联人员，负责将本团队工单分配给团队内有效成员。服务端根据登录身份验证负责人资格和工单访问权限，普通成员不能自行认领。工单具体处理人保存到 tickets.assignee_user_id。

一个部门可以包含多个运维人员，一个运维人员也可以加入多个部门。通过 team_members 保存部门与人员的多对多关系，分配工单时检查目标人员在工单所属部门中的成员资格。

team_members 保存 id、team_id、user_id；id 为主键，team_id 和 user_id 均必填，并分别通过外键关联 teams.id 和 users.id。UNIQUE (team_id, user_id) 保证同一人员不能重复加入同一部门，两个字段单独允许重复。部门名称和人员名称通过关联主表查询取得。

新工单的 assignee_user_id 为 NULL，表示尚未指定处理人；该字段允许为空，并通过外键关联用户表。负责人指定成员后写入其用户 ID，并将工单从 pending 改为 processing。部门负责人不会在建单时自动成为处理人。

运维团队可按运维服务方公司统一组织，例如统一前端组负责多个系统的界面问题。多条系统与分类分派配置可关联同一个团队。统一团队仍需按授权处理客户工单，客户数据归属与隔离保持明确。

企业、用户、角色从服务端认证结果读取。客户端和模型传入的企业、角色或处理人字段不能授予权限。附件访问执行相同授权检查，存储目录不公开为静态资源。

知识检索同时限定 business_system_id 和可访问范围；公共系统资料与本企业私有资料可以参与检索，其他企业的私有资料不能进入候选结果、提示词或引用。

## 状态与职责

咨询：检索中、已有建议、已解决、需要工单、技术失败。草稿在正式工单之外保存。

正式工单：pending 待处理、processing 处理中、waiting_customer 待用户确认、waiting_info 待补充、resolved 已解决。新建时为 pending，负责人首次指定成员成功时进入 processing，无需成员再次点击开始处理。

允许的主流程是 pending → processing → waiting_customer → resolved。运维可以从 processing 进入 waiting_info，用户补齐后回到 processing。提交用户可以从 waiting_customer 或 resolved 重新打开到 processing。每次变更记录操作者、原状态、新状态和时间。

AI 整理答案、建议问题类型和草稿字段。后端控制检索权限、字段校验、建单、分派、通知和状态变更。主线用明确的业务流程协调各模块。

## 数据设计

数据表按阶段设计和建立。下表是训练参考草案：学生先根据业务提出实体、关系、字段、约束和查询需求，再对照本表接受评审。实施以修订后的设计记录为依据。

schema-identity.sql 保留为已评审的单次教学 SQL。六表 DDL 已整理为项目 db/migrations/001-identity.sql，角色 INSERT 在 db/seed/001-roles.sql。schema_migrations 保存版本、文件名、SHA-256 校验和与时间；同次待执行迁移整体事务提交，重复跳过、历史修改拒绝。学生约束讲解和亲自执行通过。2B 通过 scripts/db-seed-users.mjs 初始化虚构公司、用户及多角色，使用真实密码哈希，重复不覆盖密码。JWT 不需要新表；2C 授权配置、第三阶段工单表、第五阶段知识向量表待补。原 vector 初始化与数据卷保留。

| 分组 | 建议表 | 关键关系 |
| --- | --- | --- |
| 身份 | companies、users、roles、user_roles；sessions 留作后续扩展 | 用户属于企业；用户与角色多对多；本阶段 JWT 验证身份和有效期 |
| 分派 | business_systems、company_systems、teams、team_members、system_issue_team_routes | 企业授权系统；系统与问题分类组合映射团队；团队包含运维用户 |
| 标准 | issue_types | 必填字段和附件规则采用 JSONB |
| 工单 | tickets、ticket_events、ticket_comments | 工单保存企业、提交人、系统、类型、团队、处理人和状态 |
| 咨询 | consultations、consultation_messages、ticket_drafts | 草稿关联咨询和用户确认信息 |
| 附件 | attachments | 保存拥有者、草稿或工单关联、私有存储位置及文件类型 |
| 通知 | notifications | 接收用户、工单、创建时间、已读时间 |
| 知识 | knowledge_documents、knowledge_chunks | 文档范围、系统、片段文本、来源、Embedding 模型标识和向量 |

工单创建、团队分派、操作历史、站内通知记录在同一个事务中保存。每次事务中的查询使用同一数据库连接，从 BEGIN 到全部成功后的 COMMIT；任一写入失败则 ROLLBACK，本次不留下部分成功的业务记录。只有 COMMIT 成功后才返回新建成功。草稿和上传附件此前已存在，建单回滚不会删除这些材料；独立保存的提交尝试时间用于继续执行一分钟重试间隔。

通知写入失败指该业务事务内的数据库操作失败。若数据已经提交，只有前端轮询、展示或 HTTP 响应失败，则重新查询或按幂等规则返回已有工单，不能把已提交的工单当作尚未创建。

分派配置的 system_id、issue_type_id、team_id 均必填，并通过外键关联业务系统、问题类型和团队主表。system_id 与 issue_type_id 设置联合唯一约束，使同一组合指向一个团队；team_id 允许在多条配置中重复。管理员界面选择有效记录，后端检查并将约束错误转换为可理解的业务反馈。

学生已明确防重规则：同一份草稿一分钟后可以重试，但只要已经成功生成正式工单，后续提交就不能再生成第二张。第一版以 tickets.draft_id 的必填、外键和唯一约束保证一份草稿最多一张工单。前端提交中显示等待并阻止重复点击，成功后关闭提示，失败或超时时保留表单；不自动重试，由用户手动触发。超时只代表尚未确认结果，不能据此判断后端没有建单。

后端在验证登录身份及草稿归属后，先确认是否已经存在关联工单。已存在且提交内容相同时返回 200、原工单 ID、created:false 和已提交提示，不重复建单或写入创建事件和通知。已建单后传入不同内容，返回 409 及获授权的原工单 ID，引导查看原工单，不能静默当作修改成功。

尚无工单时，首次创建尝试可立即执行；再次创建尝试距离上次被后端接受的创建尝试不足 60 秒时返回等待提示，达到间隔后才允许手动重试。间隔按后端时间检查，已完成工单的结果查询不受此创建间隔限制。若原提交仍在处理中，则等待或返回处理中，不并行再创建。执行建单事务时锁定对应草稿并再次检查关联工单，唯一约束作为最终保证；首次创建成功返回 201 和 created:true。用于控制重试间隔的尝试时间需要独立保存，不能随建单业务事务回滚而丢失。通用 requester_id 与 request_key 方案留作后续幂等扩展。

首次指定处理人采用 pending 状态和空处理人条件的原子更新，同时写入 assignee_user_id 和 processing 状态，竞争失败返回冲突；同一分配请求重试的处理方式由学生在接口设计时明确。分配成功、操作历史与处理人通知在同一事务保存，失败时整体回滚。

Embedding 向量维度取自实际服务返回，建表维度必须匹配。文档和问题使用同一个 Embedding 模型与配置；更换模型后重新生成该知识集合的向量。

## 接口约定

接口共同前缀为 /api。GET /health、POST /auth/login、GET /auth/me 已实现，其余接口为待实现契约。学生基于已确认设计审阅当前模块的核心逻辑，并亲自验证和修改。

| 方法与路由 | 用途 | 必须检查 |
| --- | --- | --- |
| GET /health | 已实现：应用、数据库、vector 健康状态 | 就绪时 200；数据库或扩展不可用时 503，应用仍可报告存活 |
| POST /auth/login、GET /auth/me | 2B 已实现并工程验证：登录与当前身份 | scrypt、严格 Origin、JWT 签名和 3600 秒有效期、数据库当前角色 |
| GET /systems、GET /issue-types | 系统和工单标准 | 返回当前用户获授权的范围 |
| POST /consultations | 创建咨询 | 系统权限、问题长度、当前身份 |
| GET /consultations/:id/events | 接收咨询 SSE 事件 | 咨询归属；关闭连接时取消关联任务 |
| POST /consultations/:id/feedback | 已解决或未解决反馈 | 咨询归属；重复反馈处理 |
| GET /drafts/:id、PATCH /drafts/:id | 读取和修改草稿 | 草稿归属；模型字段重新校验 |
| POST /drafts/:id/attachments | 上传附件 | 草稿归属、类型、大小；原始文件名不直接作为存储路径 |
| POST /tickets | 正式建单 | 草稿归属、系统权限、类型标准、附件归属；同一草稿唯一建单及重试内容一致性 |
| GET /tickets、GET /tickets/:id | 我的工单或详情 | 企业、提交人或运维授权 |
| POST /tickets/:id/comments | 沟通记录 | 当前工单访问权限 |
| POST /tickets/:id/assign | 部门负责人指定处理人 | 负责人身份、工单权限、目标人员属于该团队；原子条件更新 |
| POST /tickets/:id/transitions | 处理、补充、解决、重开 | 操作者角色、原状态、允许的目标状态 |
| GET /notifications、POST /notifications/:id/read | 通知与已读 | 接收用户身份 |
| GET /attachments/:id | 读取附件 | 对关联草稿或工单的访问权限 |
| POST /admin/documents | 导入知识 | 管理权限、系统与资料范围 |

训练版先用迁移和 seed 准备企业、用户、团队、系统、问题分类与分派映射；这些资源的管理员 CRUD 作为后续深入分支，不能标记为本轮已交付。

SSE 事件至少包含 status、delta、sources、draft_ready、error、done。流式连接结束后可通过查询接口恢复已保存结果。

### 草稿与附件 ID 的取得顺序

以下是待实现的响应契约示例，ID 示例以字符串表示，避免 PostgreSQL BIGINT 转为 JavaScript Number 时的精度风险。

1. 创建咨询后，后端返回咨询 ID。无有效知识依据而进入草稿流程时，后端先写入 ticket_drafts，再发送 draft_ready 事件，data 为 {"draft_id":"101"}。如果已有答案但用户点击未解决，前端调用 POST /consultations/:id/feedback，提交 {"resolved":false}；后端创建或取得该咨询已有的草稿，返回同样的 draft_id。草稿提交人及企业取自认证身份，ID 由数据库生成，模型仅提供经校验的字段建议。
2. 前端取得 draft_id 后，打开草稿页面并通过 GET /drafts/101 读取内容。用户选择截图或日志后，以 multipart/form-data 调用 POST /drafts/101/attachments，字段名为 file。后端验证草稿归属、文件类型和大小，将文件保存到私有存储并写入 attachments 元数据，成功后返回 {"id":"301","draft_id":"101","name":"error.png"}；失败时不能将该附件计为上传成功。
3. 前端保存每个成功响应的附件 ID，例如 ["301","302"]。用户确认提交时，POST /tickets 的请求包含 draft_id、attachment_ids 和已约定的工单表单字段；后端再次校验草稿与附件归属、材料规则，再创建正式工单并关联已选附件。上传未完成时界面提示等待，后端始终校验实际上传结果。
4. 草稿页面地址携带 draft_id，刷新时通过 GET /drafts/:id 恢复表单与附件元数据，不只依赖前端内存。获取草稿的响应包含 id、表单内容及 attachments 数组，数组内每个成功上传的附件都有 id 和 name。此时草稿和附件已存储，正式工单只在用户确认提交后创建。

2B 已按学生决定实现 JWT 一小时（JWT_TTL_SECONDS=3600），仅按时间过期；me 不续期。JWT 包含 sub、iat、exp、iss、aud、jti，以 HS256 签名，通过 HttpOnly、SameSite=Strict、Path=/api 的 Cookie 携带，HTTPS 的 APP_ORIGIN 下设置 Secure。Guard 验签、允许算法、签发方/接收方及时间后，以 sub 查询数据库当前用户、公司与角色。2026-10-16用户新增退出要求：POST /auth/logout校验APP_ORIGIN并清除同名/同Path认证Cookie，前端清空身份并返回登录页，允许过期/重复退出。未新增sessions、JWT撤销或黑名单，已复制JWT仍按原有效期校验。POST login 严格检查 APP_ORIGIN 并用 Zod 校验，额外 company_id 不被接收。密码、签名密钥及完整 token 不返回业务 JSON 或写入日志。资源操作权限和企业隔离仍在各业务模块单独检查，当前认证 Guard 不替代资源授权。

已实现响应为 `{user:{id,display_name,login_name,user_type,company:{id,name},roles:[{code,name}]},token_expires_at}`；ID 为字符串，到期时间为 ISO 字符串。login 设置 Cookie，me 不设置新 Cookie，两接口采用 Cache-Control: no-store。

## RAG 流程

入库：文本导入 → 按标题和段落切片 → 批量生成 Embedding → 保存文本、范围、来源与向量。

查询：识别认证身份和系统 → 生成问题向量 → 过滤可访问资料 → 相似度检索 → 检查证据 → 根据片段生成回答 → 展示对应来源 → 收集用户反馈。

从实际测试问题校准检索参数。模型自报的信心不能作为已解决的依据。引用必须指向本次检索的片段，并检查是否支持答案。技术错误、缺乏资料、用户反馈无效分别记录。

## 公司试运行条件

主流程、企业隔离、附件访问、负责人分派权限与并发冲突、幂等提交通过验收；有备份恢复和部署说明；对知识回答做固定样例评估。先内部小范围试运行，再依据结果扩大客户使用范围。

## 官方参考

- [pgvector](https://github.com/pgvector/pgvector)
- [PostgreSQL 事务](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [node-postgres 参数化查询](https://node-postgres.com/features/queries)
- [Embedding](https://help.aliyun.com/zh/model-studio/embedding)
- [工具调用](https://help.aliyun.com/zh/model-studio/qwen-function-calling)
