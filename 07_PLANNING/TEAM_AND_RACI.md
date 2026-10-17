# Team and RACI

## Suggested team (5–7)
| Role | Count | Focus |
|---|---|---|
| Tech lead / architect | 1 | Architecture, ADRs, reviews, phase gates |
| IDE/frontend engineer (Theia) | 1–2 | Extensions, Electron, parity, UX |
| Backend engineer | 1–2 | Control plane, broker, runner |
| Platform/DevOps engineer | 1 | Runtime images, K8s, Helm, CI/CD, observability |
| Security engineer (shared) | 0.5 | Threat model, reviews, pen test coordination |
| QE representative (shared) | 0.5 | Requirements, pilot, acceptance |

## RACI (R = responsible, A = accountable, C = consulted, I = informed)
| Area | Tech lead | IDE eng | Backend eng | Platform | Security | QE rep | Sponsor |
|---|---|---|---|---|---|---|---|
| Scope & priorities | C | I | I | I | C | C | **A** |
| Architecture & ADRs | **A/R** | C | C | C | C | I | I |
| Theia shell & extensions | A | **R** | C | I | I | C | I |
| Control plane & RBAC | A | C | **R** | I | C | I | I |
| SSH broker & remote FS | A | C | **R** | C | **C** | I | I |
| Runtime images & K8s | A | C | C | **R** | C | I | I |
| Secrets & identity integration | A | I | R | R | **C** | I | I |
| Security hardening & sign-off | C | R | R | R | **A** | I | I |
| CI/CD & releases | A | C | C | **R** | C | I | I |
| Pilot & adoption | C | R | R | R | I | **A/R** | I |
| GA go/no-go | R | C | C | C | C | C | **A** |

## Rituals
- Weekly: demo of the latest phase deliverable + phase gate review.
- Bi-weekly: risk register review.
- Security review at the end of P04, P08, P09, P12, P14, P16.
