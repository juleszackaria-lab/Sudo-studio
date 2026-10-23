# P47 - Inventaire des 58 commandes (arbre ou interne)

Source : sudo-ai-extension/package.json (contributes.commands) croise avec
src/views/sidebarModel.js. Fichier ASCII : les caracteres hors-ASCII sont
notes \uXXXX (texte rendu = decode). 23 commandes dans l arbre (24 entrees,
openSecurityPanel partagee par legitimite : "Couverture de tests" ouvre le
panneau Securite) + 35 internes = 58. Aucune commande supprimee, aucune
ajoutee, tous les handlers intacts.

| # | commande | titre exact | arbre (groupe > libelle) ou INTERNE + motif |
|---|---|---|---|
| 1 | sudoStudio.openDashboard | Open Dashboard | INTERNE [popup] popup info, pas une page |
| 2 | sudoStudio.openChat | Open AI Chat | Agent > Sudo Chat |
| 3 | sudoStudio.runDoctor | Run System Doctor | Outils > \uD83E\uDE7A System Doctor |
| 4 | sudoStudio.autoFix | Auto Fix Issues | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 5 | sudoStudio.installSDK | Install SDK | INTERNE [dialog] dialogue (quickpick/saisie/progres), pas une page |
| 6 | sudoStudio.refreshSDKs | Refresh SDKs | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 7 | sudoStudio.generateDocker | Generate Dockerfile | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 8 | sudoStudio.generateCICD | Generate CI/CD Pipeline | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 9 | sudoStudio.exportEnvironment | Export Environment | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 10 | sudoStudio.importEnvironment | Import Environment | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 11 | sudoStudio.createSnapshot | Create Snapshot | Environnement > Create Snapshot |
| 12 | sudoStudio.backupEnvironment | Backup Environment | Environnement > Backup Environment |
| 13 | sudoStudio.restoreEnvironment | Restore Environment | Environnement > Restore Environment |
| 14 | sudoStudio.cloneEnvironment | Clone Environment | Environnement > Clone Environment |
| 15 | sudoStudio.analyzeProject | Analyze Project | INTERNE [dup] ouvre le meme panneau qu une autre entree (meme handler) |
| 16 | sudoStudio.explainCode | Explain Code (AI) | INTERNE [ctx] action contextuelle editeur (selection requise) |
| 17 | sudoStudio.fixCode | Fix Code (AI) | INTERNE [ctx] action contextuelle editeur (selection requise) |
| 18 | sudoStudio.refactorCode | Refactor Code (AI) | INTERNE [ctx] action contextuelle editeur (selection requise) |
| 19 | sudoStudio.generateCode | Generate Code (AI) | INTERNE [ctx] action contextuelle editeur (selection requise) |
| 20 | sudoStudio.generateTests | Generate Tests (AI) | INTERNE [ctx] action contextuelle editeur (selection requise) |
| 21 | sudoStudio.addComments | Add Comments (AI) | INTERNE [ctx] action contextuelle editeur (selection requise) |
| 22 | sudoStudio.selectModel | Select AI Model | INTERNE [dialog] dialogue (quickpick/saisie/progres), pas une page |
| 23 | sudoStudio.refreshModels | Refresh Models | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 24 | sudoStudio.restartRuntime | Restart AI Runtime | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 25 | sudoStudio.checkRuntimeHealth | Check Runtime Health | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 26 | sudoStudio.reloadModel | Reload AI Model | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 27 | sudoStudio.clearRuntimeCache | Clear Runtime Cache | INTERNE [palette] maintenance, palette uniquement (comme avant P47) |
| 28 | sudoStudio.viewRuntimeLogs | View Runtime Logs | INTERNE [doc] ouvre un document editeur, pas un panneau |
| 29 | sudoStudio.clearChatHistory | Clear Chat History | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 30 | sudoStudio.openProvidersPanel | Open AI Providers Page | Runtime IA > Fournisseurs IA |
| 31 | sudoStudio.selectAIProvider | Select Active AI Provider | INTERNE [dialog] dialogue (quickpick/saisie/progres), pas une page |
| 32 | sudoStudio.openRuntimePanel | Open Runtime & Models Panel | Runtime IA > \uD83E\uDD16 Runtime & Models |
| 33 | sudoStudio.openDevOpsPanel | Open DevOps Automation Panel | Outils > \uD83D\uDE80 DevOps Automation |
| 34 | sudoStudio.openAnalysisPanel | Analyze Project (Full Panel) | Projet > \uD83D\uDD0D Project Analysis |
| 35 | sudoStudio.openSDKPanel | Open SDK Manager Panel | Outils > \uD83D\uDCE6 SDK Manager |
| 36 | sudoStudio.openEnvironmentPanel | Open Reproductible Environments Panel | Environnement > \uD83D\uDD04 Reproductible Env |
| 37 | sudoStudio.openAgentPanel | Sudo Agent | Agent > Sudo Agent |
| 38 | sudoAgent.open | Sudo Agent: Ouvrir | INTERNE [dup] ouvre le meme panneau qu une autre entree (meme handler) |
| 39 | sudoAgent.stop | Sudo Agent: Arreter | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 40 | sudoStudio.refreshDashboard | Refresh Dashboard | INTERNE [palette] maintenance, palette uniquement (comme avant P47) |
| 41 | sudoStudio.generateDockerCompose | Sudo AI: Generate Docker Compose | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 42 | sudoStudio.generateKubernetes | Sudo AI: Generate Kubernetes Config | INTERNE [panel] bouton equivalent dans son panneau + palette |
| 43 | sudoStudio.buildDocker | Sudo AI: Build Docker Image | INTERNE [palette] maintenance, palette uniquement (comme avant P47) |
| 44 | sudoStudio.optimizeDocker | Sudo AI: Optimize Dockerfile | INTERNE [palette] maintenance, palette uniquement (comme avant P47) |
| 45 | sudoStudio.applyTemplate | Sudo AI: Apply Project Template | INTERNE [palette] maintenance, palette uniquement (comme avant P47) |
| 46 | sudoStudio.openLogsFolder | Sudo : Ouvrir le dossier des journaux | Journaux > Dossier des journaux |
| 47 | sudoStudio.openLogsViewer | Sudo : Voir les journaux | Agent > Journaux de l'agent |
| 48 | sudoStudio.exportDiagnostics | Sudo : Exporter le diagnostic | Journaux > Exporter le diagnostic |
| 49 | sudoStudio.openSecurityPanel | \uD83D\uDD12 Security Audit | S\u00E9curit\u00E9 > \uD83D\uDD12 Security Audit ; S\u00E9curit\u00E9 > Couverture de tests |
| 50 | sudoStudio.openDuplicationPanel | \uD83D\uDCCB Enterprise Duplication | Duplication > \uD83D\uDCCB Enterprise Duplication |
| 51 | sudoStudio.openCentralMgmtPanel | \u2699\uFE0F Central Management | Administration > Central Management |
| 52 | sudoStudio.openAuditLog | Open Audit Log | Administration > Audit Log |
| 53 | sudoStudio.openLicensePanel | \uD83D\uDD11 License Management | Administration > \uD83D\uDD11 License Management |
| 54 | sudoStudio.openSdkInstallPanel | \u2B07 SDK Install | Outils > \u2B07 SDK Install |
| 55 | sudoStudio.runSecurityAudit | \uD83D\uDD12 Run Security Audit | S\u00E9curit\u00E9 > Lancer l'audit de s\u00E9curit\u00E9 |
| 56 | sudoStudio.cloneEnterprise | \uD83D\uDCCB Clone Enterprise Env | INTERNE [dup] ouvre le meme panneau qu une autre entree (meme handler) |
| 57 | sudoStudio.showBuildInfo | A propos du build | INTERNE [popup] popup info, pas une page |
| 58 | sudoStudio.resetLayout | R\u00E9initialiser la disposition | INTERNE [layout] commande de disposition, palette uniquement |
