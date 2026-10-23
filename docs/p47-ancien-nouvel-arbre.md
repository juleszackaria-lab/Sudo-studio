# P47 - Ancien arbre -> nouvel emplacement (rien de perdu)

Chaque vue supprimee et chaque section/entree de l'ancien arbre, avec son
nouvel emplacement. Fichier ASCII : hors-ASCII note \uXXXX (rendu = decode).
Conventions : ARBRE = entree du nouvel arbre unique "Sudo Studio" ;
PANNEAU = bouton/section dans la page principale ; PALETTE = commande
toujours contribuez, enregistree et geree (inchangee).

## 1. Vue "Sudo Agent" (webview sudoAgentLauncher) - SUPPRIMEE
| Ancien | Nouvel emplacement |
|---|---|
| Bouton "Ouvrir Sudo Agent" (-> sudoAgent.open) | ARBRE Agent > Sudo Agent (-> sudoStudio.openAgentPanel, meme panneau, avec garde licence) ; raccourci Ctrl+Alt+A inchange (-> sudoAgent.open) |

## 2. Vue "Dashboard" (sudoStudioDashboard) - SUPPRIMEE
| Ancien | Nouvel emplacement |
|---|---|
| System Status (Backend x / Runtime y) | PANNEAU Runtime & Models (sante + catalogue) ; PANNEAU System Doctor (diagnostic) ; barre de statut (etat IA temps reel) |
| Quick Actions > Sudo Agent | ARBRE Agent > Sudo Agent |
| Quick Actions > Open AI Chat | ARBRE Agent > Sudo Chat |
| Quick Actions > System Doctor | ARBRE Outils > System Doctor (titre exact du panneau) |
| Quick Actions > SDK Manager | ARBRE Outils > SDK Manager (titre exact) |
| Quick Actions > Runtime & Models | ARBRE Runtime IA > Runtime & Models (titre exact) |
| Quick Actions > DevOps Automation | ARBRE Outils > DevOps Automation (titre exact) |
| Quick Actions > Analyze Project | ARBRE Projet > Project Analysis (titre exact) |
| Quick Actions > View Logs | ARBRE Journaux > Dossier des journaux |
| Quick Actions > Open Central Management | ARBRE Administration > Central Management |
| Quick Actions > Open Audit Log | ARBRE Administration > Audit Log (ouvre le panneau Central, onglet audit) |
| Metrics > Backend/Runtime/Model | PANNEAU Runtime & Models ; barre de statut ; PANNEAU System Doctor |

## 3. Vue "Sudo Studio" (sudoStudio, nav P38) - REMPLACEE par l'arbre groupe
| Ancien (6 entrees plates) | Nouvel emplacement |
|---|---|
| AI Chat / AI Runtime / System Doctor / SDK Manager / DevOps / Project Analysis | Memes panneaux dans ARBRE (groupes Agent, Runtime IA, Outils, Projet) |

## 4. Vue "Environment" (sudoStudioEnvironment) - SUPPRIMEE
| Ancien | Nouvel emplacement |
|---|---|
| Current Environment (OS, Node, archi) | PANNEAU Reproductible Env : scan (plateforme+archi, hostname, RAM, CPU, node, outils). Dossier de travail : visible dans l'Explorateur lui-meme. |
| Actions > Export/Import Environment | PANNEAU Reproductible Env : boutons Exporter le profil / Importer & Comparer (+ PALETTE, commandes inchangees) |
| Actions > Backup/Restore/Clone Environment, Create Snapshot | ARBRE Environnement > Backup/Restore/Clone Environment, Create Snapshot (absents du panneau : ajout P47, regle de preservation) |
| Snapshots ("No snapshots available", stub TODO) | Rien a perdre (stub vide) ; commande Create Snapshot : ARBRE + PALETTE |

## 5. Vue "Security" (sudoStudioSecurity) - SUPPRIMEE
| Ancien | Nouvel emplacement |
|---|---|
| Actions > Run Security Audit | ARBRE Securite > Lancer l'audit de securite |
| Actions > Open Security Panel | ARBRE Securite > Security Audit (titre exact) |
| Coverage (secrets, .gitignore, npm audit) | PANNEAU Security Audit (scan reel _runAudit) ; ARBRE Securite > Couverture de tests (ouvre le panneau) |

## 6. Vue "Duplication" (sudoStudioDuplication) - SUPPRIMEE
| Ancien | Nouvel emplacement |
|---|---|
| Export Profile / Import & Compare | PANNEAU Enterprise Duplication : sections Export Profile / Import & Compare (+ PALETTE) |
| Clone Enterprise Env (-> cloneEnterprise) | PANNEAU Enterprise Duplication (meme handler que openDuplicationPanel) ; commande inchangee en PALETTE |
| Open Duplication Panel | ARBRE Duplication > Enterprise Duplication (titre exact) |
| Export/import de profil | PANNEAU (ci-dessus). Import de la base d'avis : aucune fonction de ce nom dans l'ancien arbre ni les panneaux (recherche "review"/"avis" : uniquement previewFilter et revue de code) : rien a reporter. |

## 7. Vue "Central" (sudoStudioCentral) - SUPPRIMEE
| Ancien | Nouvel emplacement |
|---|---|
| Manage Users / Manage Policies / Open Central Management | PANNEAU Central Management : utilisateurs, modeles, regles, strategie cloud, organisation, onglet audit ; ARBRE Administration > Central Management ; ARBRE Administration > Audit Log |

## 8. Vue "License" (sudoStudioLicense) - SUPPRIMEE
| Ancien | Nouvel emplacement |
|---|---|
| Activate License / Manage Seats / Open License Management | PANNEAU License Management : Activation, Edition Comparison, Seat Allocation ; ARBRE Administration > License Management |

## 9. Vues deja fusionnees en P38 (fichiers morts supprimes en P47)
| Ancien | Nouvel emplacement |
|---|---|
| Chat (New Chat + historique) | PANNEAU Sudo Chat (historique dans le panneau depuis P38) ; ARBRE Agent > Sudo Chat |
| Runtime (Open Runtime) | ARBRE Runtime IA > Runtime & Models |
| Doctor (Open System Doctor) | ARBRE Outils > System Doctor |
| SDK (Open SDK Manager) | ARBRE Outils > SDK Manager |
| DevOps (Open DevOps) | ARBRE Outils > DevOps Automation |

## 10. Ajouts P47 (regle d'inventaire : toute fonction visible figure dans l'arbre)
| Ajout | Motif |
|---|---|
| ARBRE Outils > SDK Install (panneau \u2B07 SDK Install) | Page existante sans entree dans la liste du spec ; ajout obligatoire par la regle d'inventaire |
| ARBRE Environnement > Backup/Restore/Clone/Snapshot | Actions de l'ancien arbre absentes du panneau (regle de preservation) |

Conteneur : id "sudo-studio", titre "Sudo Studio", icone chaine
"resources/sudo-robot.svg" (SVG mono 24x24 currentColor, dans le paquet).
Premier lancement apres mise a jour : reveal unique par version
(containerShownFor, P38-a conserve). Commande "Sudo : Reinitialiser la
disposition" (sudoStudio.resetLayout) : revele le conteneur + replie
l'arbre unique.
