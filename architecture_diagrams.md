# EvaOps Architecture Diagrams

### 1. High-Level System Architecture

```mermaid
flowchart TD
    %% Frontend Subgraph
    subgraph Frontend ["Frontend (React/Vite)"]
        UI["React SPA"]
        LocalState["localStorage<br/>(devops_token, org_id)"]
        UI -->|"Fetch API"| Backend
        LocalState -.->|"Injects Token"| UI
    end

    %% Backend Subgraph
    subgraph Backend ["Backend (Node.js/Express)"]
        API["Express API Routes"]
        Middleware["auditLogger & lazyBillPackage"]
        AppCtrl["appController.js"]
        SchedWorker["schedulerWorker.js"]
        Webhook["webhookController.js"]

        API --> Middleware
        Middleware --> AppCtrl
    end

    %% Data Layer Subgraph
    subgraph DataLayer ["Data Layer (MySQL)"]
        DB[(MySQL Database)]
    end

    %% Cloud Subgraph
    subgraph Cloud ["Azure Cloud & CI/CD"]
        AzureARM["Azure ARM APIs<br/>(AppService / ContainerApps)"]
        GitOps["GitHub / Azure DevOps<br/>(REST API)"]
        Teams["Microsoft Teams"]
    end

    %% Connections
    Frontend -->|"POST /api/apps/provision"| API
    AppCtrl -->|"mysql2 Query"| DB
    SchedWorker -->|"Polls Schedules"| DB
    AppCtrl -->|"@azure/arm-* SDK"| AzureARM
    AppCtrl -->|"Commits YAML"| GitOps
    Webhook -->|"Sends Message"| Teams
    GitOps -->|"Webhooks"| Webhook

    %% Styling
    classDef frontend fill:#61dafb,stroke:#333,stroke-width:2px,color:#000;
    classDef backend fill:#8cc84b,stroke:#333,stroke-width:2px,color:#000;
    classDef database fill:#f29111,stroke:#333,stroke-width:2px,color:#fff;
    classDef cloud fill:#0072c6,stroke:#333,stroke-width:2px,color:#fff;

    class UI,LocalState frontend;
    class API,Middleware,AppCtrl,SchedWorker,Webhook backend;
    class DB database;
    class AzureARM,GitOps,Teams cloud;
```

### 2. Multi-Tenant Entity-Relationship Diagram (ERD)

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ USERS : "contains"
    ORGANIZATIONS ||--o{ APPLICATIONS : "owns"
    ORGANIZATIONS ||--o{ SLEEP_SCHEDULES : "manages"
    ORGANIZATIONS ||--o{ AUDIT_LOGS : "audits"

    ORGANIZATIONS {
        varchar id PK
        varchar name
        varchar tenant_id
    }

    USERS {
        int id PK
        varchar organization_id FK
        varchar email
        varchar role
    }

    APPLICATIONS {
        int id PK
        varchar organization_id FK
        varchar name
        varchar app_type
        varchar status
        varchar pipeline_id
    }

    SLEEP_SCHEDULES {
        int id PK
        varchar organization_id FK
        text rules_json
        boolean active
    }

    AUDIT_LOGS {
        int id PK
        varchar actor_email
        varchar action_type
        varchar target
        json details
    }
```

### 3. Application Provisioning & GitOps Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Frontend as React UI
    participant API as Express (appController)
    participant Cred as credentialController
    participant DB as MySQL DB
    participant Azure as Azure ARM (SDK)
    participant Git as GitHub/Azure DevOps

    User->>Frontend: Submit ProvisionWizard Form
    Frontend->>API: POST /api/apps/provision (JSON Payload)
    API->>Cred: getDecryptedCredentialsInternal(orgId)
    Cred->>DB: Fetch Encrypted Secrets
    DB-->>Cred: AES-256-GCM Payload
    Cred-->>API: Decrypted Azure Service Principal
    API->>Azure: Instantiate ContainerAppsAPIClient / WebSiteManagementClient
    Azure-->>API: Resource Provisioned
    API->>API: _generateSmartYml() (Dynamic Construction)
    API->>Git: PUT /api.github.com/repos/.../contents (Commit YAML)
    Git-->>API: SHA / Pipeline ID returned
    API->>DB: INSERT INTO applications (...)
    API-->>Frontend: 200 OK (Provisioning Complete)
    Frontend-->>User: Display Success Confirmation
```

### 4. Automation Engine & Broken Webhook Feedback Loop

```mermaid
flowchart TD
    %% Scheduler Worker Flow
    subgraph Automation ["Automation Engine (schedulerWorker.js)"]
        PollDB["Query sleep_schedules"]
        MatchRule{"Rule Active & Match?"}
        ScaleZero["Set minReplicas: 0<br/>maxReplicas: 0"]

        PollDB --> MatchRule
        MatchRule -- Yes --> ScaleZero
    end

    %% Webhook Processing Flow
    subgraph WebhookLoop ["Webhook Feedback Loop (webhookController.js)"]
        Receive["POST /api/webhooks/azure-devops"]
        Parse["Parse build.complete event"]
        Notify["Send Teams MessageCard"]
        Bug(("Known Bug: Status not updated in DB"))

        Receive --> Parse
        Parse --> Notify
        Notify -.-> Bug
    end

    %% External Systems
    DB[(MySQL)]
    AzureApp["Azure Container App"]
    DevOps["Azure DevOps Service Hook"]
    TeamsMsg["Microsoft Teams Channel"]

    %% Linkages
    PollDB -.-> DB
    ScaleZero -->|"ARM API Call"| AzureApp

    DevOps -->|"Triggers"| Receive
    Notify -->|"HTTP POST"| TeamsMsg

    %% Styling
    classDef worker fill:#8cc84b,stroke:#333,stroke-width:2px,color:#000;
    classDef external fill:#0072c6,stroke:#333,stroke-width:2px,color:#fff;
    classDef bug fill:#cc3300,stroke:#333,stroke-width:2px,color:#fff;

    class PollDB,MatchRule,ScaleZero,Receive,Parse,Notify worker;
    class AzureApp,DevOps,TeamsMsg external;
    class Bug bug;
```

### 5. Feature Gating & Auto-Billing (lazyBillPackage)

```mermaid
flowchart TD
    %% Subgraphs for separation of concerns
    subgraph Client ["Client Request"]
        API_Call["Incoming API Request"]
    end

    subgraph Middleware ["lazyBillPackage Middleware"]
        CheckContext{"Has Org ID?"}
        QueryDB["Live DB SELECT: sub_package_X"]
        CheckSub{"Is Subscribed?"}
        AutoSub["DB UPDATE: Set sub_package_X = 1"]
        GenInvoice["INSERT INTO billing_invoices<br/>(Pending Status)"]
        NextCall["Allow Route Execution (next)"]
    end

    subgraph Database ["MySQL Data Layer"]
        DB[("organizations table")]
        InvDB[("billing_invoices table")]
    end

    %% Flow connections
    API_Call --> CheckContext
    CheckContext -- Yes --> QueryDB
    CheckContext -- No --> 403_Error["403 Forbidden"]

    QueryDB -->|"Query"| DB
    DB --> CheckSub

    CheckSub -- No --> AutoSub
    AutoSub -->|"Update"| DB
    AutoSub --> GenInvoice
    GenInvoice -->|"Insert"| InvDB
    GenInvoice --> NextCall

    CheckSub -- Yes --> NextCall

    %% Styling
    classDef client fill:#61dafb,stroke:#333,stroke-width:2px,color:#000;
    classDef middleware fill:#8cc84b,stroke:#333,stroke-width:2px,color:#000;
    classDef database fill:#f29111,stroke:#333,stroke-width:2px,color:#fff;
    classDef error fill:#cc3300,stroke:#333,stroke-width:2px,color:#fff;

    class API_Call client;
    class CheckContext,QueryDB,CheckSub,AutoSub,GenInvoice,NextCall middleware;
    class DB,InvDB database;
    class 403_Error error;
```

### 6. Cost Remediation Tracking

```mermaid
flowchart TD
    %% Client Request
    subgraph Client ["Client Request"]
        PostRemedy["POST /cost/apply-remediation"]
    end

    %% Controller Logic
    subgraph Controller ["appController.js"]
        InvokeGetCost["_getCostAndOptimizationData"]
        ExecuteAzure["Execute Azure API Changes<br/>e.g., scaling, tier demotion"]
        InsertRemedy["INSERT ON DUPLICATE KEY UPDATE<br/>applied_remediations"]
    end

    %% Cloud & Database
    subgraph Cloud ["Azure Cloud"]
        AzureARM["Azure AppService / ContainerApps"]
    end

    subgraph Database ["MySQL Data Layer"]
        AppDB[("applications / applied_remediations")]
    end

    %% Flow connections
    PostRemedy --> InvokeGetCost
    InvokeGetCost --> ExecuteAzure
    ExecuteAzure -->|"ARM SDK Calls"| AzureARM
    ExecuteAzure --> InsertRemedy
    InsertRemedy -->|"Persist Audit Record"| AppDB

    %% Styling
    classDef client fill:#61dafb,stroke:#333,stroke-width:2px,color:#000;
    classDef controller fill:#8cc84b,stroke:#333,stroke-width:2px,color:#000;
    classDef database fill:#f29111,stroke:#333,stroke-width:2px,color:#fff;
    classDef cloud fill:#0072c6,stroke:#333,stroke-width:2px,color:#fff;

    class PostRemedy client;
    class InvokeGetCost,ExecuteAzure,InsertRemedy controller;
    class AppDB database;
    class AzureARM cloud;
```
