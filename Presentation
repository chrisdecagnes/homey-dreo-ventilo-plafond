# DREO Ventilo-plafond (community) – application Homey Pro

Application Homey communautaire (SDK 3, non officielle) qui pilote, via le cloud Dreo, les ventilateurs de plafond que l'application officielle `com.dreo.connect` ne prend pas encore en charge.

Chaque ventilateur apparaît dans Homey sous forme de **3 appareils indépendants**, que l'on peut ranger, renommer et piloter séparément (« Homey, éteins les lumières du salon » inclut la lumière et l'anneau) :

| Appareil Homey | Classe | Capacités | Clés Dreo |
|---|---|---|---|
| … – Ventilateur | ventilateur | marche/arrêt, vitesse 1-12, mode normal / naturel (silencieux) / sommeil / auto (CF712S) / inversé-hiver (CF521S, CLF521S) | `fanon`, `windlevel`, `mode` |
| … – Lumière | lumière | marche/arrêt, intensité, température du blanc | `lighton`, `brightness`, `colortemp` |
| … – Anneau LED (RGBIC uniquement) | lumière | marche/arrêt, intensité, couleur fixe, scène (Vague, Fleur de cerisier, Noël, Halloween, Fête d'anniversaire, Luciole) | `atmon`, `atmbri`, `atmcolor` (CF521S) ou effet RGBIC « Constant » (CF712S), API REST `rgb-effect` |

| Nom commercial | Modèle cloud Dreo | Appareils créés |
|---|---|---|
| CF712S (RGBIC) | DR-HCF002S | ventilateur + lumière + anneau |
| CF521S (RGBIC) | DR-HCF007S | ventilateur + lumière + anneau |
| CLF521S | DR-HCF521S | ventilateur + lumière |

Les trois appareils d'un même ventilateur partagent un état commun (`lib/DreoFanHub.js`) : c'est indispensable, car sur les CF712S/CF521S allumer la lumière quand tout est éteint impose d'envoyer aussi l'état des autres parties.

Cartes Flow : les cartes natives de Homey (allumer, éteindre, intensité, température du blanc, « est allumé »…) fonctionnent pour les trois appareils. S'y ajoutent : *régler la vitesse*, *choisir le mode*, *le mode est…*, *le mode / la vitesse a changé* (ventilateur) et *lancer une scène*, *la scène a changé* (anneau), *activer/désactiver la programmation* et *la programmation est active* (ventilateur).

## Programmation hebdomadaire

La présentation s'inspire de l'app « Homey Heating Scheduler ». On y accède dans l'appli Homey : **Plus → Applications → DREO Ventilo-plafond (community) → Configurer l'application**.

- **Vue d'ensemble** : la liste des ventilateurs, chacun avec son nombre d'horaires et un interrupteur qui active ou suspend sa programmation sans effacer les horaires. Le journal des dernières exécutions s'affiche dessous.
- **Page d'un ventilateur** :
  - Des onglets **Lu Ma Me Je Ve Sa Di**, avec un point sur le jour actuel.
  - La liste des horaires du jour, triés par heure. Chaque horaire allume ou éteint le ventilateur, la lumière ou l'anneau, avec une pastille de couleur.
  - Une ligne « En début de journée » rappelle l'état hérité de la veille.
  - Un **résumé de la semaine** en frise 0-24 h montre les plages allumées de chaque partie.
- **Bouton +** : ajoute un horaire au jour affiché. On choisit l'heure, l'appareil, l'action et des options : vitesse et mode pour le ventilateur, intensité et blanc pour la lumière, intensité et scène pour l'anneau. Un bouton **Tester maintenant** permet d'essayer l'horaire. Toucher un horaire existant ouvre sa modification.
- **Icône copier** : recopie les horaires du jour affiché vers les jours cochés (raccourci « Semaine »). Ils remplacent les horaires existants de ces jours.
- Chaque modification est enregistrée aussitôt.
- Deux cartes Flow, « activer/désactiver la programmation » et « la programmation est active », permettent par exemple de couper la programmation pendant les vacances.

Fonctionnement technique :

- Les heures suivent le fuseau horaire de la Homey, heure d'été comprise.
- Le moteur (`lib/Scheduler.js`) vérifie toutes les 20 s et n'exécute chaque horaire qu'une fois par minute.
- Un horaire qui tombe pendant un redémarrage de la Homey n'est pas rattrapé.
- Les horaires créés en v0.3 (format « règle + jours ») sont convertis automatiquement.

## Installation sur la Homey Pro (mode développeur)

Il faut un ordinateur avec Node.js 18 ou plus récent.

```bash
npm install --global homey     # CLI Homey
homey login                    # compte Athom
cd com.christophe.dreoceilingfans
npm install                    # installe la dépendance "ws"
homey app run                  # lance l'app sur la Homey, avec les journaux en direct
# ou, pour l'installer de façon permanente :
homey app install
```

Ensuite, dans l'application Homey : **Appareils → + → DREO Ventilo-plafond (community)**, puis ajoutez successivement **Ventilation**, **Lumière** et **Anneau LED RGBIC** (trois passages, le compte Dreo n'est demandé qu'au premier).

Mise à jour depuis la v0.1 : les anciens appareils (« Ventilateur de plafond… » tout-en-un) ne sont plus gérés. Supprimez-les dans Homey avant d'installer la v0.2 ou plus, puis ajoutez les nouveaux. De la v0.2 à la v0.3, rien à refaire : les appareils existants sont conservés et l'anneau reçoit automatiquement la couleur fixe. Le compte est partagé par les trois pilotes. Le mot de passe n'est jamais stocké en clair : seule son empreinte MD5 est gardée, car c'est le format qu'exige l'API Dreo.

`homey app run` est le meilleur moyen de faire les premiers essais : chaque commande envoyée s'affiche dans la console (`→ Dreo SN {...}`).

## Fonctionnement

- `lib/DreoApi.js` : client REST du cloud Dreo. Il gère la connexion, la région EU/NA détectée automatiquement, la liste des appareils, l'état et les effets RGBIC.
- `lib/DreoSocket.js` : WebSocket `wss://wsb-eu.dreo-tech.com`. Il envoie les commandes une par une, attend l'accusé de réception et réessaie au besoin. Il reçoit aussi l'état en temps réel, y compris les changements faits avec la télécommande ou l'appli Dreo, et gère la reconnexion automatique.
- `lib/CeilingFanState.js` : modèle d'état et logique de **porte d'alimentation**. Sur les CF712S/CF521S, une charge est réellement allumée quand `poweron` ET `<charge>on` sont vrais. Pour allumer une seule charge quand tout est éteint, il faut envoyer en une seule commande `poweron:true`, la charge voulue, et les autres charges à `false`. Éteindre la dernière charge renvoie aussi `poweron:false`. Le CLF521S n'a pas de porte.
- `lib/DreoFanHub.js` : un hub par ventilateur physique, partagé par ses 3 appareils Homey.
- `lib/DreoDevice.js` et `lib/DreoDriver.js` : appareil et pilote Homey communs aux trois rôles (`drivers/fan`, `drivers/light`, `drivers/ring`). Après chaque commande, l'état est relu par REST 10 s plus tard, car le cloud a plusieurs secondes de retard. Une relecture complète a aussi lieu toutes les 5 minutes.
- `lib/Scheduler.js`, `settings/index.html`, `api.js` : programmation horaire (moteur, page de réglages, API de la page).
- `tools/compose.js` : régénère `app.json` à partir de `.homeycompose/` sans la CLI. La CLI le fait aussi automatiquement.

Le protocole n'est pas documenté par Dreo. Il vient du projet open source [hass-dreo](https://github.com/JeffSteinbok/hass-dreo) (licence MIT), qui prend en charge ces trois modèles dans Home Assistant.
