import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import gsap from 'gsap';

// ============================================================================
// 0. CONFIGURATION — tout est en mètres.
//    Ces constantes sont la source de vérité de la géométrie : elles serviront
//    telles quelles pour les collisions et le saut (étape suivante).
// ============================================================================
const STREET = {
  length: 60,           // longueur totale sur Z
  zStart: 10,           // la rue va de z = +10 (dos du joueur) à z = -50
  roadWidth: 5,         // largeur de la chaussée
  sidewalkWidth: 2.2,   // largeur d'un trottoir
  curbHeight: 0.18,     // hauteur de la marche du trottoir
};

const BLOCK = {
  length: 7.5,          // 8 blocs x 7,5 m = 60 m pile : la rue est bâtie de bout en bout
  count: 8,
  depth: 4,             // profondeur des volumes bâtis
  groundHeight: 3.5,    // rez-de-chaussée / vitrines
  upperHeight: 7.5,     // étages
  setback: 0.5,         // retrait des étages par rapport au nu de la vitrine
};

const LOOK = {
  fogColor: 0xd59b58,
  fogDensity: 0.025,    // 0.035 auparavant : à 20 m tout disparaissait, on ne voyait plus les textures
  retroHeight: 432,     // hauteur de rendu interne (~480p) quelle que soit la taille de l'écran
  groundAnisotropy: 4,  // mettre 1 pour un rendu strictement PS2 (sol franchement flou au loin)
};

// Ciel. La couleur d'horizon n'est pas réécrite en dur : elle référence
// LOOK.fogColor, seule façon de garantir que la jonction sol/ciel reste
// invisible même si vous retouchez l'ambiance de la rue.
const SKY = {
  radius: 70,        // doit rester sous le plan lointain (90), sinon le dôme est tranché
  zenith: 0x3a4f66,  // bleu-gris crépusculaire ; 0x2c3e50 pour une nuit plus avancée
  horizon: LOOK.fogColor,
  exponent: 1.3,     // > 1 étire la bande chaude vers le haut ; < 1 assombrit plus vite
};

const EYE_HEIGHT = 1.7;

// Encombrement du joueur, vu de dessus. 0,40 m le tient assez loin des façades
// pour que la caméra n'entre jamais dans une toile (elle dépasse de 7,5 cm) ni
// dans la potence d'un spot (25 cm), tout en le laissant s'approcher à ~32 cm
// d'une oeuvre, de quoi la remplir tout l'écran.
const PLAYER = { radius: 0.4 };

// Physique verticale. La gravité est plus vive que les 9,81 m/s² réels : c'est
// l'usage dans les jeux, un saut réel paraît flottant. À 5,2 m/s d'impulsion on
// s'élève de v²/2g = 0,61 m et on retombe en un peu moins d'une demi-seconde.
const PHYSICS = {
  gravity: 22,
  jumpSpeed: 5.2,
  stepHeight: 0.35, // marche franchie sans sauter — le trottoir n'en fait que 0,18
};

// Champ de vision. Le fov de three.js est VERTICAL : tel quel, un téléphone tenu
// à la verticale (rapport ~0,46) ne montrerait qu'environ 36° d'horizontale, on
// n'y verrait plus la rue. On élargit donc le vertical en portrait pour récupérer
// un horizontal correct, en plafonnant pour ne pas trop déformer les bords.
const VIEW = {
  fov: 70,       // vertical, en paysage
  maxFov: 82,    // au-delà la déformation devient pénible
  minHFov: 68,   // horizontal visé quand l'écran est étroit
};

// Réglages tactiles (section 14).
const TOUCH = {
  // Le doigt parcourt bien moins de distance qu'une souris. À 0,0045 rad/px, un
  // balayage sur toute la largeur d'un téléphone (~390 px) fait tourner d'une
  // centaine de degrés ; à 0,0032 il fallait s'y reprendre à deux fois.
  lookSpeed: 0.0045,
  deadZone: 0.12,     // sous ce seuil le joystick est considéré au repos
  tapSlop: 16,        // px de dérive : au-delà, le doigt balayait, ce n'est pas une tape
  hintDelay: 5,       // s d'affichage de l'aide au premier passage
};

// Un vrai écran tactile, pas un portable avec dalle tactile : c'est ce couple qui
// distingue « pas de survol possible » de « souris disponible ».
const TOUCH_MODE = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// Valeurs dérivées — ne pas modifier à la main.
const ROAD_HALF = STREET.roadWidth / 2;                     // 2.5  — bord de chaussée
const FACADE_X = ROAD_HALF + STREET.sidewalkWidth;          // 4.7  — nu des vitrines
const SIDEWALK_CX = ROAD_HALF + STREET.sidewalkWidth / 2;   // 3.6  — axe d'un trottoir
const Z_CENTER = STREET.zStart - STREET.length / 2;         // -20  — milieu de la rue
const blockZ = (i) => STREET.zStart - BLOCK.length / 2 - i * BLOCK.length;

// Chemins servis depuis public/
const TEX = {
  asphalt: '/assets/asphalt.jpg',
  sidewalk: '/assets/sol_trotoire.jpg',
  facade: '/assets/facade.jpg',
  garage: '/assets/porte_garage.jpg',
  shop: '/assets/lyca.png',
};

// Réglages d'accrochage communs à toutes les oeuvres.
const GALLERY = {
  hangHeight: 1.45,   // hauteur du CENTRE de la toile au-dessus du trottoir (norme musée : 1,45–1,55 m)
  panelMargin: 0.11,  // débord du panneau de fond tout autour de la toile
  panelDepth: 0.012,  // décollement du panneau : assez pour ne pas z-fighter avec la façade
  canvasDepth: 0.06,  // épaisseur du châssis : la toile doit être un objet, pas un autocollant
  lights: true,       // éclairage d'exposition (potence + tête) — passer à false pour l'enlever
  reach: 20,          // portée du viseur : au-delà, une toile n'est plus cliquable
};

// LA GALERIE. Ajouter une oeuvre = ajouter une ligne ; c'est `z` qui la place.
// Repères pour choisir un z :
//   - le joueur apparaît en z = +5 et regarde vers les z décroissants ;
//   - la rue est bâtie de z = +10 à z = -50 ;
//   - le brouillard (FogExp2 0.025) efface 50 % de l'image à 33 m et 80 % à 51 m,
//     donc au-delà de z = -30 une toile n'est plus vraiment lisible ;
//   - les portes de garage occupent les blocs pairs : un contrôle console
//     prévient si une toile tombe dessus (voir checkClearance plus bas).
// L'alternance gauche / droite est volontairement décalée en z : on a toujours
// une oeuvre devant soi, jamais deux en vis-à-vis.
// Le titre affiché dans la visionneuse est déduit du nom de fichier ; ajouter un
// champ `title: '...'` sur une ligne pour lui donner un vrai nom à la place.
//
// La sculpture, elle, est posée sur la corniche du rez-de-chaussée : les étages
// étant en retrait de BLOCK.setback, le toit des vitrines laisse un rebord de
// 50 cm à 3,50 m de haut, sur toute la longueur de la rue.
const SCULPTURE = {
  src: '/assets/sculpture_web.glb',
  height: 1.25,     // hauteur voulue en mètres — un personnage accroupi
  side: 'left',
  z: -9,            // au-dessus de la porte de garage du bloc 2
  // Relevés dans le maillage lui-même : le personnage est accroupi, et le point
  // le plus bas de sa moitié arrière forme un plat net à 0,32 de sa hauteur —
  // c'est l'assise. Devant, ça retombe à 0 : les pieds. La bascule est pile au
  // Z d'origine du modèle, qu'on fait donc coïncider avec le bord de la corniche.
  // Exprimé en fraction de la hauteur, pour rester valable si `height` change.
  seatHeight: 0.32,
  sink: 0.015,      // enfoncement dans la corniche : évite deux surfaces coplanaires
};
const ARTWORKS = [
  { src: '/assets/tableau/Sofia.png', size: 1.5, side: 'left',  z: -2 },    // bleu roi, très contrasté : la première chose qu'on voit
  { src: '/assets/tableau/Toumani.png', size: 1.4, side: 'right', z: -5.5 },  // ocre sourd : placé près, sinon le brouillard le mange
  { src: '/assets/tableau/Soheila.png', size: 1.5, side: 'left',  z: -12 },   // jaune / bleu : relance le regard vers le fond de la rue
  { src: '/assets/tableau/Fanta.png', size: 1.4, side: 'right', z: -16.5 }, // brun chaud : tient encore à 22 m grâce au panneau sombre
  { src: '/assets/tableau/Zenji.png', size: 1.4, side: 'left',  z: -20.5 }, // rouille
  { src: '/assets/tableau/Mahere.png', size: 1.5, side: 'right', z: -29 },   // orange saturé : la seule teinte qui tienne à 34 m
];

// ============================================================================
// 1. SCÈNE, BROUILLARD ET CAMÉRA
// ============================================================================
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(LOOK.fogColor, LOOK.fogDensity);
// Le dôme couvre désormais tout le champ : ce fond n'est plus qu'un filet de
// sécurité, pour qu'un dôme mal réglé ne laisse pas du noir.
scene.background = new THREE.Color(LOOK.fogColor);

// --- Dôme de ciel ---
// Une sphère retournée, recentrée sur la caméra à chaque image, dégradée du
// brouillard à l'horizon vers un bleu-gris au zénith.
//
// Deux points méritent l'attention :
//
// 1. `#include <colorspace_fragment>`. THREE.Color range ses composantes en
//    linéaire et les matériaux natifs les reconvertissent en sRGB en fin de
//    shader ; un ShaderMaterial écrit à la main, non. Sans cette ligne l'horizon
//    sortirait en RGB(170, 84, 25) au lieu de RGB(213, 155, 88) — bien plus
//    sombre que le brouillard, et la jointure sauterait aux yeux. La fonction
//    linearToOutputTexel, elle, est fournie d'office par le préfixe de three.js.
//
// 2. Le dégradé suit l'axe Y LOCAL du dôme, pas le Y monde. Le dôme étant collé
//    à la caméra, son équateur est toujours à hauteur d'oeil : c'est la
//    définition même de l'horizon. Avec le Y monde, la ligne d'horizon
//    glisserait à chaque saut et à chaque montée sur le trottoir.
const skyMesh = new THREE.Mesh(
  new THREE.SphereGeometry(SKY.radius, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false, // le brouillard n'a pas à teinter le ciel : l'horizon EST sa couleur
    uniforms: {
      uZenith: { value: new THREE.Color(SKY.zenith) },
      uHorizon: { value: new THREE.Color(SKY.horizon) },
      uExponent: { value: SKY.exponent },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform float uExponent;
      varying vec3 vLocal;

      void main() {
        // -1 au nadir, 0 à l'horizon, +1 au zénith. La normalisation est faite
        // par fragment : interpoler un vecteur déjà normalisé le dénormaliserait
        // entre deux sommets, et le dégradé se briserait sur les arêtes.
        float h = normalize(vLocal).y;
        float t = pow(clamp(h, 0.0, 1.0), uExponent);
        gl_FragColor = vec4(mix(uHorizon, uZenith, t), 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
);
// Dessiné en premier, sans écrire dans le tampon de profondeur : il tient lieu
// de fond et tout le reste se peint par-dessus sans qu'il n'occulte jamais rien.
skyMesh.renderOrder = -1;
scene.add(skyMesh);

const camera = new THREE.PerspectiveCamera(VIEW.fov, window.innerWidth / window.innerHeight, 0.1, 90);
camera.position.set(0, EYE_HEIGHT, 5);

// Sur un écran large on garde les 70° verticaux ; sur un écran étroit on ouvre
// le vertical juste assez pour atteindre VIEW.minHFov à l'horizontale.
function applyFov() {
  const aspect = window.innerWidth / window.innerHeight;
  const neededFov = (2 * Math.atan(Math.tan((VIEW.minHFov * Math.PI) / 360) / aspect) * 180) / Math.PI;
  camera.fov = Math.min(VIEW.maxFov, Math.max(VIEW.fov, neededFov));
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}
applyFov();

// ============================================================================
// 2. RENDU BASSE RÉSOLUTION PS2
//    On rend à hauteur fixe (432 px) puis on étire en pixels nets : le grain
//    est ainsi identique sur un portable et sur un écran 4K.
// ============================================================================
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });

function applyRetroSize() {
  const scale = Math.min(1, LOOK.retroHeight / window.innerHeight);
  renderer.setSize(Math.round(window.innerWidth * scale), Math.round(window.innerHeight * scale), false);
  // Taille CSS en pixels, et non en 100vw/100vh : sur mobile, vh se réfère au
  // viewport « large », barre d'adresse dépliée comprise, alors que le rendu est
  // calculé sur window.innerHeight, qui lui rétrécit avec la barre. Les deux ne
  // coïncident pas et l'image se retrouve étirée en hauteur.
  renderer.domElement.style.width = window.innerWidth + 'px';
  renderer.domElement.style.height = window.innerHeight + 'px';
}
renderer.domElement.style.imageRendering = 'pixelated';
renderer.domElement.style.position = 'fixed';
renderer.domElement.style.inset = '0';
applyRetroSize();
document.body.appendChild(renderer.domElement);
document.body.style.margin = '0';
document.body.style.overflow = 'hidden';
document.body.style.background = '#000';

// ============================================================================
// 3. CHARGEMENT DES TEXTURES
// ============================================================================
const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

function setupTex(tex, { repeat = [1, 1], offset = [0, 0], wrap = THREE.RepeatWrapping, aniso = 1 }) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = wrap;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.offset.set(offset[0], offset[1]);
  tex.magFilter = THREE.NearestFilter;            // texels bien carrés de près : c'est le look PS2
  tex.minFilter = THREE.LinearMipmapLinearFilter; // mipmaps au loin, sinon la rue scintille dès qu'on avance
  tex.generateMipmaps = true;
  tex.anisotropy = Math.min(aniso, MAX_ANISO);
  return tex;
}

function loadTex(url, opts = {}) {
  const tex = loader.load(url, undefined, undefined, () => {
    console.error('[texture] échec de chargement : ' + url);
  });
  return setupTex(tex, opts);
}

// Réutilise l'image d'une texture déjà chargée avec un autre cadrage UV.
// Le clone partage la Source : une seule image en VRAM, car three.js indexe la
// texture GPU par wrap / filtre / anisotropie et PAS par repeat ni offset
// (WebGLTextures.js, getTextureCacheKey). Cloner avant la fin du téléchargement
// est sûr : TextureLoader remplit la Source partagée, il ne la remplace pas
// (Texture.js:422, « set image » écrit dans this.source.data).
function reuseTex(tex, { repeat, offset = [0, 0] }) {
  const clone = tex.clone();
  clone.repeat.set(repeat[0], repeat[1]);
  clone.offset.set(offset[0], offset[1]);
  clone.needsUpdate = true;
  return clone;
}

// --- Chaussée : 1 tuile d'asphalte = 5 m ---
const asphaltTex = loadTex(TEX.asphalt, {
  repeat: [STREET.roadWidth / 5, STREET.length / 5], // [1, 12]
  aniso: LOOK.groundAnisotropy,
});

// --- Trottoir : repeat.x FORCÉ à 1 ---
// La texture porte sa bordure (pierre claire + caniveau) sur son bord droit, sur
// ~12 % de sa largeur. Elle ne doit donc jamais se répéter en X, sinon une
// bordure fantôme réapparaît au milieu du trottoir.
const SIDEWALK_REPEAT_Y = STREET.length / STREET.sidewalkWidth; // ~27,3 : texels carrés
const sidewalkTex = loadTex(TEX.sidewalk, {
  repeat: [1, SIDEWALK_REPEAT_Y],
  aniso: LOOK.groundAnisotropy,
});
// Sur la face +Y d'une BoxGeometry, U suit +X et V suit -Z
// (three.js r185, BoxGeometry.js:78 -> buildPlane('x','z','y', 1, 1, ...)).
//   Trottoir GAUCHE, de x=-4.7 à x=-2.5 : U=1 tombe côté rue -> bordure déjà bien placée.
//   Trottoir DROIT,  de x=+2.5 à x=+4.7 : U=1 tombe côté immeubles -> il faut retourner la texture.
// repeat.x = -1 avec offset.x = 1 donne u' = 1 - u, soit un miroir horizontal propre.
const sidewalkTexMirrored = reuseTex(sidewalkTex, {
  repeat: [-1, SIDEWALK_REPEAT_Y],
  offset: [1, 0],
});

// --- Façade : 1 tuile = 1 bloc en largeur.
// La texture est raccordable horizontalement, donc avec repeat.x = 1 les blocs
// s'enchaînent sans couture. En hauteur elle contient 4 rangées de fenêtres :
// un repeat.y multiple de 1/4 coupe donc toujours entre deux rangées, jamais au
// milieu d'une fenêtre. 0,75 -> 3 niveaux sur 7,5 m, soit 2,5 m par étage.
const facadeTex = loadTex(TEX.facade, { repeat: [1, 0.75] });
// Rez-de-chaussée : une seule rangée (1/4) étirée sur 3,5 m -> vitrines hautes.
const shopTex = reuseTex(facadeTex, { repeat: [1, 0.25] });

// --- Porte de garage : une pièce unique, jamais répétée. ---
const garageTex = loadTex(TEX.garage, { wrap: THREE.ClampToEdgeWrapping });

// ============================================================================
// 4. MATÉRIAUX
// ============================================================================
const roadMat = new THREE.MeshLambertMaterial({ map: asphaltTex });
const curbMat = new THREE.MeshLambertMaterial({ color: 0x8a8880 }); // flancs et nez de trottoir
const garageMat = new THREE.MeshLambertMaterial({ map: garageTex });

// Un BoxGeometry expose ses 6 faces dans cet ordre (BoxGeometry.js:76-81) :
// 0 = +X, 1 = -X, 2 = +Y, 3 = -Y, 4 = +Z, 5 = -Z.
// Seule la face du dessus du trottoir mérite la texture de dalles ; les flancs
// reçoivent une couleur unie, sinon les dalles seraient écrasées sur 18 cm.
function sidewalkMaterials(topTex) {
  const top = new THREE.MeshLambertMaterial({ map: topTex });
  return [curbMat, curbMat, top, curbMat, curbMat, curbMat];
}

// ============================================================================
// 5. SOL : CHAUSSÉE + TROTTOIRS SURÉLEVÉS
//    Chaussée, trottoirs et immeubles couvrent exactement le même intervalle
//    z = [+10, -50]. (Auparavant ils étaient décalés et laissaient voir le vide.)
// ============================================================================
const road = new THREE.Mesh(new THREE.PlaneGeometry(STREET.roadWidth, STREET.length), roadMat);
road.rotation.x = -Math.PI / 2;
road.position.z = Z_CENTER;
scene.add(road);

function createSidewalk(xPos, topTex) {
  const geo = new THREE.BoxGeometry(STREET.sidewalkWidth, STREET.curbHeight, STREET.length);
  const mesh = new THREE.Mesh(geo, sidewalkMaterials(topTex));
  mesh.position.set(xPos, STREET.curbHeight / 2, Z_CENTER);
  scene.add(mesh);
  return mesh;
}
createSidewalk(-SIDEWALK_CX, sidewalkTex);          // gauche : orientation naturelle
createSidewalk(SIDEWALK_CX, sidewalkTexMirrored);   // droite : texture retournée

// ============================================================================
// 6. IMMEUBLES
//    Variations déterministes (mêmes valeurs à chaque rechargement) pour casser
//    la répétition : décalage horizontal des UV et légère variation de teinte.
// ============================================================================
const UV_SHIFTS = [0, 0.37, 0.13, 0.61, 0.29];          // décalage UV par bloc
const TINTS = [0xffffff, 0xf0e6d8, 0xffeedd, 0xe8e2d6]; // teintes de façade

// Emprise en Z de chaque porte de garage, pour vérifier qu'aucune toile
// ne vient s'accrocher par-dessus (voir checkClearance, section 9).
const garageSpans = [];

function createBuildingBlock(side, index) {
  const xDir = side === 'left' ? -1 : 1;
  const zPos = blockZ(index);
  const seed = index + (side === 'right' ? 2 : 0);

  // Rez-de-chaussée : le nu de la vitrine est exactement au bord du trottoir.
  const shop = new THREE.Mesh(
    new THREE.BoxGeometry(BLOCK.depth, BLOCK.groundHeight, BLOCK.length),
    new THREE.MeshLambertMaterial({
      map: reuseTex(shopTex, { repeat: [1, 0.25], offset: [UV_SHIFTS[seed % UV_SHIFTS.length], 0] }),
      color: TINTS[seed % TINTS.length],
    })
  );
  shop.position.set(xDir * (FACADE_X + BLOCK.depth / 2), BLOCK.groundHeight / 2, zPos);
  scene.add(shop);

  // Étages, légèrement en retrait.
  const upper = new THREE.Mesh(
    new THREE.BoxGeometry(BLOCK.depth, BLOCK.upperHeight, BLOCK.length),
    new THREE.MeshLambertMaterial({
      map: reuseTex(facadeTex, { repeat: [1, 0.75], offset: [UV_SHIFTS[(seed + 1) % UV_SHIFTS.length], 0] }),
      color: TINTS[(seed + 1) % TINTS.length],
    })
  );
  upper.position.set(
    xDir * (FACADE_X + BLOCK.setback + BLOCK.depth / 2),
    BLOCK.groundHeight + BLOCK.upperHeight / 2,
    zPos
  );
  scene.add(upper);

  // Corniche en surplomb.
  const corniceDepth = BLOCK.setback + 0.3;
  const cornice = new THREE.Mesh(
    new THREE.BoxGeometry(corniceDepth, 0.4, BLOCK.length),
    new THREE.MeshLambertMaterial({ color: 0x4a453f })
  );
  cornice.position.set(
    xDir * (FACADE_X + corniceDepth / 2 - 0.1),
    BLOCK.groundHeight + BLOCK.upperHeight + 0.2,
    zPos
  );
  scene.add(cornice);

  // Un bloc sur deux reçoit une porte de garage ; les autres gardent un mur nu,
  // qui est justement ce qu'il faut pour accrocher une toile.
  if (seed % 2 === 0) createGarageDoor(xDir, zPos);
}

// ============================================================================
// 7. PORTES DE GARAGE
//    Quad plaqué 3 cm devant la vitrine pour éviter le z-fighting.
// ============================================================================
const GARAGE = { width: 2.6, height: 2.8, offset: 0.03 };

function createGarageDoor(xDir, z) {
  const door = new THREE.Mesh(new THREE.PlaneGeometry(GARAGE.width, GARAGE.height), garageMat);
  door.position.set(xDir * (FACADE_X - GARAGE.offset), STREET.curbHeight + GARAGE.height / 2, z);
  // Un PlaneGeometry regarde +Z ; on le tourne pour qu'il regarde la rue.
  door.rotation.y = xDir === -1 ? Math.PI / 2 : -Math.PI / 2;
  scene.add(door);
  garageSpans.push({ xDir, from: z - GARAGE.width / 2, to: z + GARAGE.width / 2 });
}

for (let i = 0; i < BLOCK.count; i++) {
  createBuildingBlock('left', i);
  createBuildingBlock('right', i);
}

// ============================================================================
//    L'ÉPICERIE
//    L'image est une élévation frontale complète, sa marge de mur en brique
//    comprise. On la plaque donc sur TOUTE la hauteur du rez-de-chaussée, du
//    trottoir jusqu'à la corniche : cadrée plus petit, cette brique ferait une
//    rustine collée sur le crépi. Sa largeur découle du rapport de l'image, pour
//    qu'aucune lettre de l'enseigne ne soit étirée.
//    Elle est centrée sur la jonction de deux blocs — c'est là que les façades
//    changent de teinte et de décalage UV. Le commerce vient donc masquer la
//    couture en même temps qu'il s'installe entre les deux immeubles.
// ============================================================================
const SHOP = {
  side: 'right',
  z: -12.5,     // couture entre les blocs 2 et 3
  offset: 0.03, // plaquée comme les portes de garage
  glow: 0.35,   // intensité de l'éclairage intérieur (voir plus bas)
};

function createShopFront(tex) {
  const height = BLOCK.groundHeight - STREET.curbHeight; // 3,32 m, trottoir -> corniche
  const width = height * (tex.image.width / tex.image.height);
  const xDir = SHOP.side === 'left' ? -1 : 1;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshLambertMaterial({
      map: tex,
      // La façade de droite tourne le dos au soleil : elle ne reçoit que
      // l'ambiante, et le commerce s'y enfoncerait dans la pénombre. L'emissiveMap
      // rallume chaque pixel proportionnellement à sa propre couleur — l'enseigne
      // bleue s'illumine, la brique reste sombre. C'est le comportement d'une
      // vitrine éclairée de l'intérieur, pas un rattrapage arbitraire.
      emissiveMap: tex,
      emissive: 0xffffff,
      emissiveIntensity: SHOP.glow,
    })
  );
  mesh.position.set(xDir * (FACADE_X - SHOP.offset), STREET.curbHeight + height / 2, SHOP.z);
  // Un PlaneGeometry regarde +Z ; même convention que les portes de garage.
  mesh.rotation.y = xDir === -1 ? Math.PI / 2 : -Math.PI / 2;
  scene.add(mesh);
}

// Chargée à part des autres textures : on a besoin des dimensions de l'image
// pour en déduire la largeur du commerce.
loader.load(
  TEX.shop,
  (tex) => {
    setupTex(tex, { wrap: THREE.ClampToEdgeWrapping, aniso: LOOK.groundAnisotropy });
    createShopFront(tex);
  },
  undefined,
  () => console.error('[épicerie] échec de chargement : ' + TEX.shop)
);

// Immeubles de fond qui ferment la rue aux deux bouts : sans eux on voit le vide
// dès qu'on se retourne.
function createEndWall(z, towardPositiveZ) {
  const width = 2 * (FACADE_X + BLOCK.depth);
  const height = BLOCK.groundHeight + BLOCK.upperHeight;
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, BLOCK.depth),
    new THREE.MeshLambertMaterial({
      map: reuseTex(facadeTex, { repeat: [width / BLOCK.length, 0.75] }),
      color: 0xe8e2d6,
    })
  );
  wall.position.set(0, height / 2, z + (towardPositiveZ ? BLOCK.depth / 2 : -BLOCK.depth / 2));
  scene.add(wall);
}
createEndWall(STREET.zStart, true);
createEndWall(STREET.zStart - STREET.length, false);

// ============================================================================
// 8. MOBILIER URBAIN : LAMPADAIRES ET CÔNES VOLUMÉTRIQUES
// ============================================================================
const poleMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
const coneMat = new THREE.MeshBasicMaterial({
  color: 0xffd97d,
  transparent: true,
  opacity: 0.18,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

// Colliders en plan, lus par resolveCollisions (section 12) : cercles pour ce
// qu'on contourne en glissant (mâts, bacs), rectangles pour ce qu'on longe
// (barrières).
const OBSTACLES = [];
const BLOCKERS = [];

function createStreetLight(x, z, rotateY) {
  const group = new THREE.Group();

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4, 6), poleMat);
  pole.position.y = 2;
  group.add(pole);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.5), poleMat);
  head.position.set(0, 4, 0.2);
  group.add(head);

  const cone = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3.8, 8, 1, true), coneMat);
  cone.position.set(0, 2, 0.2);
  group.add(cone);

  group.position.set(x, STREET.curbHeight, z);
  group.rotation.y = rotateY;
  scene.add(group);
  // 0,10 m : le rayon du mât à sa base (0,08) avec une marge.
  OBSTACLES.push({ x, z, radius: 0.1 });
}

// Un lampadaire tous les deux blocs, en alternance d'un trottoir à l'autre,
// posé à 30 cm du bord du trottoir.
for (let i = 0; i < BLOCK.count; i += 2) {
  const onLeft = (i / 2) % 2 === 0;
  createStreetLight(onLeft ? -(ROAD_HALF + 0.3) : ROAD_HALF + 0.3, blockZ(i), onLeft ? 0 : Math.PI);
}

// ============================================================================
//    OBSTACLES : POUBELLES ET BARRIÈRES
//    Ils sont là pour casser la ligne droite. La chaussée fait 5 m de large et
//    rien n'y traînait : on la traversait sans jamais tourner le volant.
//    Les bacs prennent un collider circulaire — on glisse autour — et les
//    barrières une emprise rectangulaire, qu'on longe.
//    Attention : les collisions sont en plan (XZ) et ignorent la hauteur. On ne
//    saute donc pas par-dessus une barrière, ce qui est de toute façon le cas
//    dans la réalité avec 1,10 m de haut.
// ============================================================================
const binBodyMat = new THREE.MeshLambertMaterial({ color: 0x36413a });
const binBaseMat = new THREE.MeshLambertMaterial({ color: 0x1b1f1c });
const LID_MATS = {
  vert: new THREE.MeshLambertMaterial({ color: 0x2f6b3a }),
  jaune: new THREE.MeshLambertMaterial({ color: 0xc8a51e }),
  blanc: new THREE.MeshLambertMaterial({ color: 0x9fa39c }),
};
const barrierMat = new THREE.MeshLambertMaterial({ color: 0x8e928c });

const BIN = { width: 0.72, height: 1.02, depth: 0.6, radius: 0.45 };

// Bac roulant, façon collecte parisienne : cuve sombre, couvercle coloré selon
// le flux. Posé sur le sol réel du point (trottoir ou chaussée).
function createBin(x, z, rotY, flux) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(BIN.width, BIN.height, BIN.depth),
    binBodyMat
  );
  body.position.y = BIN.height / 2 + 0.1;
  group.add(body);

  // Socle sombre à la place des roues : à 480p on ne verrait pas des roues, mais
  // l'ombre sous la cuve, elle, se lit.
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(BIN.width - 0.1, 0.1, BIN.depth - 0.08),
    binBaseMat
  );
  base.position.y = 0.05;
  group.add(base);

  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(BIN.width + 0.04, 0.09, BIN.depth + 0.04),
    LID_MATS[flux]
  );
  lid.position.y = BIN.height + 0.14;
  group.add(lid);

  group.position.set(x, groundHeight(x), z);
  group.rotation.y = rotY;
  scene.add(group);

  OBSTACLES.push({ x, z, radius: BIN.radius });
}

// Barrière Vauban, toujours en travers de la rue : gardée alignée sur les axes,
// pour que son emprise rectangulaire colle vraiment à ce qu'on voit. Une
// barrière en biais aurait un collider plus gros qu'elle, et on buterait dans le
// vide.
const BARRIER = { height: 1.06, depth: 0.44, bars: 8 };

function createBarrier(x, z, length) {
  const group = new THREE.Group();
  const add = (geo, px, py, pz) => {
    const m = new THREE.Mesh(geo, barrierMat);
    m.position.set(px, py, pz);
    group.add(m);
  };

  const railGeo = new THREE.BoxGeometry(length, 0.05, 0.04);
  add(railGeo, 0, BARRIER.height, 0);
  add(railGeo, 0, BARRIER.height - 0.42, 0);

  const barGeo = new THREE.BoxGeometry(0.025, BARRIER.height - 0.06, 0.025);
  for (let i = 0; i < BARRIER.bars; i++) {
    const t = (i + 0.5) / BARRIER.bars - 0.5;
    add(barGeo, t * (length - 0.12), (BARRIER.height - 0.06) / 2 + 0.03, 0);
  }

  // Pieds en U : deux montants et une traverse au sol de chaque côté.
  const legGeo = new THREE.BoxGeometry(0.05, BARRIER.height, 0.05);
  const footGeo = new THREE.BoxGeometry(0.05, 0.04, BARRIER.depth);
  for (const s of [-1, 1]) {
    add(legGeo, (s * length) / 2, BARRIER.height / 2, 0);
    add(footGeo, (s * length) / 2, 0.02, 0);
  }

  group.position.set(x, groundHeight(x), z);
  scene.add(group);

  BLOCKERS.push({
    minX: x - length / 2,
    maxX: x + length / 2,
    minZ: z - BARRIER.depth / 2,
    maxZ: z + BARRIER.depth / 2,
  });
}

// L'implantation. Un bac isolé se contourne d'un pas ; ce qui fait vraiment
// dévier, c'est la barrière qui mange la moitié de la chaussée, et le joueur qui
// doit choisir son côté. Les deux sont posées en quinconce pour dessiner une
// chicane sur la longueur de la rue.
createBin(-3.5, -4.6, 0.12, 'vert');
createBin(-3.5, -5.45, -0.08, 'jaune');
createBarrier(-1.4, -6.5, 2.2);

createBin(3.45, -10.2, -0.15, 'vert');   // devant l'épicerie, à sa hauteur
createBin(3.45, -11.05, 0.06, 'blanc');

createBarrier(1.4, -19, 2.2);
createBin(1.15, -25, 0.3, 'jaune');       // bac esseulé au milieu de la chaussée
createBin(-3.45, -31.5, -0.1, 'vert');


// ============================================================================
// 9. LA GALERIE : ACCROCHAGE DES OEUVRES
//    Chaque toile est un petit montage posé sur la façade :
//      panneau sombre -> détache l'oeuvre du crépi beige. Sans lui, les toiles
//                        à fond ocre (2, 4, 5) se fondent dans la façade, qui a
//                        exactement la même famille de teintes qu'elles ;
//      châssis épais  -> une toile est un objet accroché au mur, pas un décalque ;
//      potence + tête -> le détail qui dit « oeuvre exposée » quand on s'approche.
//    Repère local du montage : +Z sort du mur vers la rue.
// ============================================================================
const panelMat = new THREE.MeshLambertMaterial({ color: 0x2a2622 });
const canvasEdgeMat = new THREE.MeshLambertMaterial({ color: 0x1c1a17 });
const lampHeadMat = new THREE.MeshBasicMaterial({ color: 0xffe6b0 });

// Les toiles seules sont visées par le viseur (section 13).
const ARTWORK_MESHES = [];

// « /assets/tableau/1.png » -> « 1 ». Les tirets et soulignés deviennent des
// espaces, donc renommer un fichier suffit à retitrer l'oeuvre.
function titleFromSrc(src) {
  return src.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
}

function loadArtTexture(src) {
  const tex = loader.load(src, undefined, undefined, () => {
    console.error('[galerie] toile introuvable : ' + src);
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  // Seule exception au NearestFilter du reste de la rue : une oeuvre doit rester
  // lisible, on ne lui inflige pas le crénelage volontaire des façades.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = Math.min(4, MAX_ANISO);
  return tex;
}

// Garde-fou : prévient en console si une toile tombe sur une porte de garage ou
// sort de la rue bâtie. C'est ce qui rend les z de ARTWORKS retouchables sans risque.
function checkClearance(art, xDir, panelSize) {
  const half = panelSize / 2 + 0.1;

  const clash = garageSpans.some(
    (g) => g.xDir === xDir && art.z - half < g.to && art.z + half > g.from
  );
  if (clash) console.warn(`[galerie] ${art.src} (z=${art.z}) recouvre une porte de garage.`);

  const zMin = STREET.zStart - STREET.length + half;
  const zMax = STREET.zStart - half;
  if (art.z < zMin || art.z > zMax) {
    console.warn(`[galerie] ${art.src} (z=${art.z}) sort de la rue bâtie [${zMin}, ${zMax}].`);
  }
}

function hangArtwork(art) {
  const xDir = art.side === 'left' ? -1 : 1;
  const panelSize = art.size + 2 * GALLERY.panelMargin;
  checkClearance(art, xDir, panelSize);

  // Le montage est posé au nu de la façade et tourné vers la rue : dans son repère
  // local, +Z s'éloigne du mur, exactement comme pour les portes de garage.
  const mount = new THREE.Group();
  mount.position.set(xDir * FACADE_X, STREET.curbHeight + GALLERY.hangHeight, art.z);
  mount.rotation.y = xDir === -1 ? Math.PI / 2 : -Math.PI / 2;
  scene.add(mount);

  const panel = new THREE.Mesh(new THREE.PlaneGeometry(panelSize, panelSize), panelMat);
  panel.position.z = GALLERY.panelDepth;
  mount.add(panel);

  // Sur un BoxGeometry, la face +Z est le matériau n° 4 (BoxGeometry.js:80) : c'est
  // elle qui regarde la rue, elle seule porte l'oeuvre. Les tranches restent sombres.
  // MeshBasic pour l'oeuvre : elle garde ses vraies couleurs, l'ambiance ambrée de
  // la rue ne vient pas la teinter.
  const artMat = new THREE.MeshBasicMaterial({ map: loadArtTexture(art.src) });
  const canvas = new THREE.Mesh(
    new THREE.BoxGeometry(art.size, art.size, GALLERY.canvasDepth),
    [canvasEdgeMat, canvasEdgeMat, canvasEdgeMat, canvasEdgeMat, artMat, canvasEdgeMat]
  );
  canvas.position.z = GALLERY.panelDepth + 0.002 + GALLERY.canvasDepth / 2;
  canvas.userData = { src: art.src, title: art.title ?? titleFromSrc(art.src), size: art.size };
  mount.add(canvas);
  ARTWORK_MESHES.push(canvas);

  if (GALLERY.lights) addArtLight(mount, art.size);
  return mount;
}

// Spot d'exposition : une potence sombre et une petite tête allumée.
// Pas de cône volumétrique ici, contrairement aux lampadaires de la section 8 :
// un cône additif posé devant la toile déposerait l'arête nette de sa base en
// travers de l'oeuvre, et à 480p il ne se lirait de toute façon que de très près.
// La toile est en MeshBasic, donc déjà à pleine luminosité pendant que la façade
// Lambert s'assombrit : elle se lit comme éclairée sans qu'on ajoute rien.
function addArtLight(mount, size) {
  const fixtureY = size / 2 + 0.18;

  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.2), poleMat);
  arm.position.set(0, fixtureY, 0.1);
  mount.add(arm);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.1), lampHeadMat);
  head.position.set(0, fixtureY - 0.02, 0.2);
  mount.add(head);
}

ARTWORKS.forEach((art) => hangArtwork(art));

// --- La sculpture sur sa corniche ---
// Le GLB sort de Blender déjà normalisé — 1 unité de haut, base exactement à
// Y = 0 — mais on ne s'appuie pas là-dessus : tout est recalculé depuis la boîte
// englobante réelle, pour que le placement reste juste si vous réexportez le
// modèle à une autre échelle ou avec un autre centrage.
function placeSculpture(root) {
  const raw = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  if (raw.y === 0) {
    console.error('[sculpture] modèle vide ou sans géométrie');
    return;
  }
  root.scale.setScalar(SCULPTURE.height / raw.y);

  // Le personnage regarde son axe +Z local : le boîtier, l'objectif et les verres
  // fumés sont tous du côté +Z du modèle. On le tourne vers la rue, avec la même
  // convention que les toiles.
  const xDir = SCULPTURE.side === 'left' ? -1 : 1;
  root.rotation.y = xDir === -1 ? Math.PI / 2 : -Math.PI / 2;

  // Boîte relue APRÈS mise à l'échelle et rotation, pour ne rien supposer du
  // centrage du modèle.
  const box = new THREE.Box3().setFromObject(root);
  const seatY = box.min.y + SCULPTURE.seatHeight * (box.max.y - box.min.y);

  root.position.set(
    // Le bord de la corniche tombe sur le Z d'origine du modèle : les fesses
    // restent posées dessus, les jambes passent dans le vide.
    xDir * FACADE_X,
    BLOCK.groundHeight - SCULPTURE.sink - seatY, // l'assise affleure la corniche
    SCULPTURE.z - (box.min.z + box.max.z) / 2    // centré sur le z demandé
  );
  scene.add(root);
}

new GLTFLoader(manager).load(
  SCULPTURE.src,
  (gltf) => placeSculpture(gltf.scene),
  undefined,
  () => console.error('[sculpture] échec de chargement : ' + SCULPTURE.src)
);

// ============================================================================
// 10. LUMIÈRES
// ============================================================================
scene.add(new THREE.AmbientLight(0xd5b085, 0.85));
const sunLight = new THREE.DirectionalLight(0xfff0d0, 1.2);
sunLight.position.set(10, 20, 10);
scene.add(sunLight);

// ============================================================================
// 11. ÉCRAN DE CHARGEMENT
// ============================================================================
const overlay = document.createElement('div');
overlay.textContent = 'CHARGEMENT...';
Object.assign(overlay.style, {
  position: 'fixed',
  inset: '0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#1a1410',
  color: '#d59b58',
  font: '14px monospace',
  letterSpacing: '0.35em',
  cursor: 'default',
  zIndex: '10',
  transition: 'opacity 0.4s',
});
document.body.appendChild(overlay);

// Tant que les textures ne sont pas là, entrer donnerait une rue blanche. C'est
// surtout vrai au doigt, où l'on tape l'écran par réflexe pendant le chargement.
let ready = false;

manager.onProgress = (url, loaded, total) => {
  overlay.textContent = 'CHARGEMENT ' + Math.round((loaded / total) * 100) + '%';
};
manager.onLoad = () => {
  ready = true;
  overlay.textContent = TOUCH_MODE ? 'TOUCHER POUR ENTRER' : 'CLIQUER POUR ENTRER';
  overlay.style.cursor = 'pointer';
};
manager.onError = (url) => {
  console.error('[chargement] ressource introuvable : ' + url);
};

// ============================================================================
// 12. DÉPLACEMENT
//     Deux façons d'entrer dans la rue : au clavier/souris le verrouillage de
//     pointeur fait foi ; sur écran tactile il n'existe pas, c'est le drapeau
//     `entered` qui tient ce rôle. Tout le reste du code interroge isPlaying().
//     Chaque image résout d'abord le déplacement horizontal et ses collisions,
//     puis la verticale — la hauteur du sol dépend du X finalement retenu.
// ============================================================================
const controls = new PointerLockControls(camera, document.body);

let entered = false;

function showOverlay(text) {
  overlay.textContent = text;
  overlay.style.opacity = '1';
  overlay.style.pointerEvents = 'auto';
}

function enterStreet() {
  entered = true;
  overlay.style.opacity = '0';
  overlay.style.pointerEvents = 'none';
  hud.style.opacity = '1';
  if (TOUCH_MODE) showTouchUI();
}

function pauseStreet() {
  entered = false;
  hud.style.opacity = '0';
  if (TOUCH_MODE) hideTouchUI();
  showOverlay(TOUCH_MODE ? 'TOUCHER POUR REPRENDRE' : 'CLIQUER POUR REPRENDRE');
}

function isPlaying() {
  if (viewerOpen) return false;
  return TOUCH_MODE ? entered : controls.isLocked;
}

overlay.addEventListener('click', () => {
  if (!ready) return;
  if (TOUCH_MODE) enterStreet();
  else controls.lock();
});

controls.addEventListener('lock', enterStreet);
controls.addEventListener('unlock', () => {
  hud.style.opacity = '0';
  // Ouvrir une toile déverrouille aussi la souris. Dans ce cas la visionneuse
  // prend la main, et c'est sa fermeture qui rendra la vue au joueur.
  if (!viewerOpen) pauseStreet();
});
// Le navigateur peut refuser de rendre la main (verrou trop rapproché d'un Échap,
// onglet en arrière-plan). Sans ce filet on resterait figé sans rien à cliquer.
document.addEventListener('pointerlockerror', () => {
  if (!viewerOpen) pauseStreet();
});

const keys = { KeyW: false, KeyA: false, KeyS: false, KeyD: false };
document.addEventListener('keydown', (e) => {
  if (e.code in keys) keys[e.code] = true;
  // Espace hors de `keys` : c'est une impulsion, pas un état. Le maintenir
  // enchaîne les sauts, ce qui est le comportement attendu d'un FPS.
  if (e.code === 'Space') {
    e.preventDefault();
    tryJump();
  }
});
document.addEventListener('keyup', (e) => { if (e.code in keys) keys[e.code] = false; });

const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
let prevTime = performance.now();

// Entrée de déplacement unifiée, dans [-1, 1] : z vers l'avant, x vers la droite.
// Le clavier est tout ou rien, le joystick est analogique — d'où le seuil de
// repos et le plafonnement à 1 plutôt qu'une normalisation, qui écraserait les
// petits mouvements du pouce en course maximale.
function readMoveInput(out) {
  if (TOUCH_MODE) {
    out.set(joystick.x, 0, joystick.y);
    if (out.length() < TOUCH.deadZone) out.set(0, 0, 0);
  } else {
    // Sur AZERTY, e.code vaut KeyW pour la touche Z et KeyA pour la touche Q :
    // le ZQSD marche sans rien remapper.
    out.set(Number(keys.KeyD) - Number(keys.KeyA), 0, Number(keys.KeyW) - Number(keys.KeyS));
  }
  if (out.length() > 1) out.normalize();
  return out;
}

// --- Collisions ------------------------------------------------------------
// La rue est un couloir fermé : plutôt que de confronter la caméra à chaque mur,
// on la maintient dans le rectangle délimité par le nu des vitrines et par les
// deux immeubles de fond. C'est exact, ça se rogne axe par axe — ce qui donne
// gratuitement le glissement le long d'une façade — et surtout c'est
// intraversable par construction, là où un test de trajectoire pourrait laisser
// passer au travers en une image de retard.
const WALLS = {
  minX: -(FACADE_X - PLAYER.radius),                          // -4,3
  maxX: FACADE_X - PLAYER.radius,                             // +4,3
  minZ: STREET.zStart - STREET.length + PLAYER.radius,        // -49,6 (mur du fond)
  maxZ: STREET.zStart - PLAYER.radius,                        //  +9,6 (mur derrière le spawn)
};

function clampToStreet(pos) {
  pos.x = Math.min(WALLS.maxX, Math.max(WALLS.minX, pos.x));
  pos.z = Math.min(WALLS.maxZ, Math.max(WALLS.minZ, pos.z));
}

function resolveCollisions(pos) {
  // Emprises rectangulaires (barrières). On teste contre la boîte élargie du
  // rayon du joueur et on ressort par le côté le plus proche : le déplacement
  // le long de la barrière est conservé, on la longe au lieu de s'y coller.
  for (const b of BLOCKERS) {
    const r = PLAYER.radius;
    const minX = b.minX - r;
    const maxX = b.maxX + r;
    const minZ = b.minZ - r;
    const maxZ = b.maxZ + r;
    if (pos.x <= minX || pos.x >= maxX || pos.z <= minZ || pos.z >= maxZ) continue;

    const out = Math.min(pos.x - minX, maxX - pos.x, pos.z - minZ, maxZ - pos.z);
    if (out === pos.x - minX) pos.x = minX;
    else if (out === maxX - pos.x) pos.x = maxX;
    else if (out === pos.z - minZ) pos.z = minZ;
    else pos.z = maxZ;
  }

  // Mâts : on repousse radialement, ce qui fait contourner le poteau plutôt que
  // s'y arrêter net. Aucun risque de le franchir d'un bond : à 2,5 m/s et avec
  // un delta plafonné à 0,1 s, un pas fait au plus 25 cm pour un obstacle large
  // de 1 m une fois le rayon du joueur ajouté.
  for (const o of OBSTACLES) {
    const dx = pos.x - o.x;
    const dz = pos.z - o.z;
    const reach = o.radius + PLAYER.radius;
    const dist = Math.hypot(dx, dz);
    if (dist >= reach) continue;
    if (dist < 1e-4) {
      pos.x = o.x + reach; // pile sur l'axe du mât : on sort par la droite
      continue;
    }
    pos.x = o.x + (dx / dist) * reach;
    pos.z = o.z + (dz / dist) * reach;
  }

  // Le couloir tranche en dernier : être repoussé par un poteau ne doit jamais
  // faire sortir des murs.
  clampToStreet(pos);
}

// --- Sol, gravité et saut --------------------------------------------------
// Le sol ne dépend que de X : chaussée au centre, trottoirs surélevés de part et
// d'autre, et ils courent sur toute la longueur de la rue. Pas besoin de tester
// quoi que ce soit en Z.
function groundHeight(x) {
  return Math.abs(x) >= ROAD_HALF ? STREET.curbHeight : 0;
}

let grounded = true;

function updateVertical(delta) {
  const floor = groundHeight(camera.position.x) + EYE_HEIGHT;
  const wasGrounded = grounded;

  velocity.y -= PHYSICS.gravity * delta;
  camera.position.y += velocity.y * delta;

  // Marche montante : on enjambe le trottoir sans avoir à sauter. Le pas d'une
  // image (0,22 m au pire) est plus petit que la marche, donc on ne peut pas
  // passer sous le sol : on est simplement remonté dessus.
  if (camera.position.y < floor) {
    camera.position.y = floor;
    velocity.y = 0;
    grounded = true;
    return;
  }

  // Marche descendante : qui marchait au sol y reste. Sans ça, chaque descente
  // de trottoir décollerait le joueur pendant 0,13 s, et faire un aller-retour
  // sur le bord produirait un sautillement permanent.
  if (wasGrounded && velocity.y <= 0 && camera.position.y - floor <= PHYSICS.stepHeight) {
    camera.position.y = floor;
    velocity.y = 0;
    grounded = true;
    return;
  }

  grounded = false;
}

function tryJump() {
  if (!grounded || !isPlaying()) return;
  velocity.y = PHYSICS.jumpSpeed;
  grounded = false;
}

function animate() {
  const time = performance.now();
  // Borné : sans ça, revenir sur l'onglet après 10 s téléporte le joueur.
  const delta = Math.min((time - prevTime) / 1000, 0.1);
  prevTime = time;

  if (isPlaying()) {
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;

    // moveForward() reçoit -velocity.z : l'avant doit donc creuser velocity.z.
    const input = readMoveInput(direction);
    const speed = 25.0;
    velocity.x -= input.x * speed * delta;
    velocity.z -= input.z * speed * delta;

    controls.moveRight(-velocity.x * delta);
    controls.moveForward(-velocity.z * delta);
    resolveCollisions(camera.position);
    // Après la résolution horizontale : la hauteur du sol dépend du X retenu.
    updateVertical(delta);
    // Aussi au doigt désormais : le viseur reste caché, mais la visée pilote le
    // bouton d'ouverture.
    updateAim();
  }

  // Recentré à chaque image, y compris en pause : le joueur ne peut ni sortir du
  // dôme ni s'en approcher, et l'horizon reste exactement à hauteur d'oeil.
  skyMesh.position.copy(camera.position);

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  applyFov();
  applyRetroSize();
  // Le rectangle de départ de l'animation a été mesuré dans l'ancienne fenêtre :
  // on retombe sur un simple zoom arrière plutôt que de replier la toile à côté.
  if (viewerOpen) openedFrom = { x: 0, y: 0, scale: 0.9 };
});

// ============================================================================
// 13. VISIONNEUSE : CLIQUER UNE TOILE POUR LA VOIR EN GRAND
//     Le monde est rendu en ~432p : agrandir une oeuvre DANS la scène la
//     montrerait en gros pixels. La visionneuse est donc un calque HTML, où le
//     PNG d'origine est affiché à sa vraie définition.
//     L'ouverture utilise la technique FLIP : l'image est posée à sa taille
//     finale, ramenée par transform sur le rectangle qu'occupait la toile à
//     l'écran, puis relâchée par GSAP. La toile semble venir à nous.
// ============================================================================
const VIEWER_CSS = `
.hud { position: fixed; inset: 0; z-index: 5; pointer-events: none; opacity: 0;
       transition: opacity .25s; font: 12px monospace; letter-spacing: .3em;
       color: #f0d9b5; text-shadow: 0 1px 3px #000; }
.hud__cross { position: absolute; left: 50%; top: 50%; width: 3px; height: 3px;
              margin: -1.5px 0 0 -1.5px; background: #fff; opacity: .5;
              box-shadow: 0 0 0 1px rgba(0,0,0,.6);
              transition: transform .15s, opacity .15s; }
.hud--aiming .hud__cross { transform: scale(2.6); opacity: .95; }
.hud__label { position: absolute; left: 0; right: 0; top: calc(50% + 28px);
              text-align: center; opacity: 0; transition: opacity .2s; }
.hud--aiming .hud__label { opacity: 1; }
.hud__label b { display: block; font-weight: normal; font-size: 15px;
                letter-spacing: .18em; text-transform: uppercase; margin-bottom: 7px; }
.hud__label span { opacity: .65; }

.viewer { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; }
.viewer[hidden] { display: none; }
.viewer__backdrop { position: absolute; inset: 0; background: #0d0a08; opacity: 0; }
.viewer__fig { position: relative; margin: 0; display: grid; place-items: center; }
.viewer__img { display: block; max-width: 86vw; max-height: 78vh;
               box-shadow: 0 30px 90px rgba(0,0,0,.8); will-change: transform; }
.viewer__cap { margin-top: 18px; text-align: center; font: 13px monospace;
               letter-spacing: .3em; text-transform: uppercase; color: #d59b58; }
.viewer__close { position: absolute; z-index: 1;
                 top: max(22px, env(safe-area-inset-top, 0px));
                 right: max(22px, env(safe-area-inset-right, 0px));
                 background: none; border: 1px solid #4a3d2e; color: #d59b58;
                 font: 11px monospace; letter-spacing: .25em; padding: 9px 14px;
                 cursor: pointer; }
.viewer__close:hover { border-color: #d59b58; }

/* Écran étroit ou peu haut : la toile laisse la place au cartouche et au bouton,
   et la cible du bouton passe au-dessus des 44 px recommandés au doigt. */
@media (max-width: 720px), (max-height: 560px) {
  .viewer__img { max-width: 92vw; max-height: 62vh; }
  .viewer__cap { margin-top: 14px; font-size: 11px; letter-spacing: .2em;
                 padding: 0 16px; }
  .viewer__close { padding: 14px 16px; font-size: 10px; }
  .hud__label { font-size: 11px; }
  .hud__label b { font-size: 13px; }
}
`;
document.head.appendChild(
  Object.assign(document.createElement('style'), { textContent: VIEWER_CSS })
);

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML =
  '<i class="hud__cross"></i>' +
  '<div class="hud__label"><b></b><span>[ CLIC ] AGRANDIR</span></div>';
// Le viseur ne sert qu'à la souris : au doigt on désigne la toile directement,
// un réticule au centre laisserait croire qu'il faut viser.
if (TOUCH_MODE) hud.style.display = 'none';
document.body.appendChild(hud);
const hudTitle = hud.querySelector('b');

const viewer = document.createElement('div');
viewer.className = 'viewer';
viewer.hidden = true;
viewer.innerHTML =
  '<div class="viewer__backdrop"></div>' +
  '<figure class="viewer__fig">' +
  '<img class="viewer__img" alt="">' +
  '<figcaption class="viewer__cap"></figcaption>' +
  '</figure>' +
  '<button class="viewer__close" type="button">FERMER [ ECHAP ]</button>';
document.body.appendChild(viewer);
const backdrop = viewer.querySelector('.viewer__backdrop');
const viewerImg = viewer.querySelector('.viewer__img');
const viewerCap = viewer.querySelector('.viewer__cap');
const closeBtn = viewer.querySelector('.viewer__close');

const raycaster = new THREE.Raycaster();
raycaster.far = GALLERY.reach;
const SCREEN_POINT = new THREE.Vector2();

let viewerOpen = false;
let aimed = null;                             // toile actuellement visée
let openedFrom = { x: 0, y: 0, scale: 0.9 };  // départ du FLIP, rejoué à l'envers

// La toile sous un point de l'écran, en coordonnées normalisées [-1, 1].
// Le viseur du clavier interroge le centre ; une tape sur mobile interroge le
// doigt. Face avant seulement : le test sur materialIndex évite de viser une
// oeuvre par l'arrière en traversant un immeuble, ce qui reste possible tant
// qu'il n'y a pas de collisions.
function artworkAt(nx, ny) {
  SCREEN_POINT.set(nx, ny);
  raycaster.setFromCamera(SCREEN_POINT, camera);
  for (const hit of raycaster.intersectObjects(ARTWORK_MESHES, false)) {
    if (hit.face && hit.face.materialIndex === 4) return hit.object;
  }
  return null;
}

// Depuis un événement pointeur, en pixels CSS.
function artworkAtClient(clientX, clientY) {
  return artworkAt(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1
  );
}

function updateAim() {
  const target = viewerOpen ? null : artworkAt(0, 0);
  if (target === aimed) return;
  aimed = target;
  if (target) hudTitle.textContent = target.userData.title;
  hud.classList.toggle('hud--aiming', Boolean(target));
  // Au doigt, c'est le bouton d'ouverture qui matérialise la visée : pas de
  // réticule, mais le bouton qui surgit quand une toile est au centre.
  setActionTarget(target);
}

// Rectangle occupé à l'écran, en pixels CSS, par la face avant de la toile.
function screenRect(mesh) {
  const half = mesh.userData.size / 2;
  const corner = new THREE.Vector3();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      corner
        .set(sx * half, sy * half, GALLERY.canvasDepth / 2)
        .applyMatrix4(mesh.matrixWorld)
        .project(camera);
      const x = (corner.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-corner.y * 0.5 + 0.5) * window.innerHeight;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX };
}

// Personne n'attend le résultat de openViewer : une exception y passerait
// inaperçue et laisserait viewerOpen à vrai, donc le joueur sans commandes,
// définitivement. D'où le try/catch qui rend toujours la main.
async function openViewer(mesh) {
  if (viewerOpen) return;
  viewerOpen = true;

  try {
    const from = screenRect(mesh);
    viewerCap.textContent = mesh.userData.title;
    viewerImg.src = mesh.userData.src;

    // On rend la souris pour pouvoir cliquer dans la visionneuse. Les touches
    // encore enfoncées sont remises à zéro, sinon on repart en glissade au retour.
    controls.unlock();
    hideTouchUI();
    for (const code of Object.keys(keys)) keys[code] = false;
    velocity.set(0, 0, 0);
    hud.classList.remove('hud--aiming');
    aimed = null;

    viewer.hidden = false;
    gsap.set(viewerImg, { opacity: 0 });
    gsap.to(backdrop, { opacity: 0.97, duration: 0.45, ease: 'power2.out' });
    blockGhostClick();

    // decode() ne sert qu'à connaître les dimensions de l'image avant de
    // l'animer. Sur mobile il peut ne jamais se résoudre sur un PNG de 3 Mo, et
    // l'attendre sans limite laissait l'écran noir, sans image et sans
    // commandes : au bout de 250 ms on continue avec une taille approchée.
    await Promise.race([
      viewerImg.decode().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);

    const to = viewerImg.getBoundingClientRect();
    openedFrom = to.width
      ? {
          x: from.cx - (to.x + to.width / 2),
          y: from.cy - (to.y + to.height / 2),
          scale: from.w / to.width,
        }
      : { x: 0, y: 0, scale: 0.9 };

    gsap.set(viewerImg, { ...openedFrom, opacity: 1 });
    gsap.to(viewerImg, { x: 0, y: 0, scale: 1, duration: 0.7, ease: 'power3.out' });
    gsap.fromTo(
      [viewerCap, closeBtn],
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.4, delay: 0.3, ease: 'power2.out' }
    );
  } catch (err) {
    console.error('[galerie] ouverture impossible', err);
    viewer.hidden = true;
    viewer.style.pointerEvents = '';
    viewerOpen = false;
    resumeAfterViewer();
  }
}

// Après une tape, le navigateur émet encore un clic de compatibilité à l'endroit
// touché. Le voile venant d'apparaître sous le doigt, ce clic fantôme le
// refermait aussitôt. La visionneuse reste donc insensible le temps qu'il passe.
let ghostTimer = null;
function blockGhostClick() {
  if (!TOUCH_MODE) return;
  viewer.style.pointerEvents = 'none';
  clearTimeout(ghostTimer);
  ghostTimer = setTimeout(() => {
    viewer.style.pointerEvents = '';
  }, 400);
}

function closeViewer() {
  if (!viewerOpen) return;
  viewerOpen = false;

  gsap.to([viewerCap, closeBtn], { opacity: 0, duration: 0.18 });
  gsap.to(backdrop, { opacity: 0, duration: 0.42, delay: 0.08 });
  gsap.to(viewerImg, {
    ...openedFrom,
    duration: 0.45,
    ease: 'power3.in',
    onComplete: () => {
      viewer.hidden = true;
      clearTimeout(ghostTimer);
      viewer.style.pointerEvents = '';
      gsap.set(viewerImg, { clearProps: 'all' });
      resumeAfterViewer();
    },
  });
}

// Fermer une toile rend directement la vue au joueur : il n'a rien demandé
// d'autre que de refermer, donc on ne le remet pas en pause. Le clic ou la touche
// qui a déclenché la fermeture fait office de geste utilisateur pour redemander
// le verrouillage ; s'il est refusé, pointerlockerror remet le voile.
function resumeAfterViewer() {
  if (TOUCH_MODE) enterStreet();
  else controls.lock();
}

closeBtn.addEventListener('click', closeViewer);
backdrop.addEventListener('click', closeViewer);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && viewerOpen) closeViewer();
});

// Souris uniquement : le tactile ouvre les toiles à la tape, en section 14.
// Le clic qui verrouille la souris passe aussi par ici, mais isLocked est encore
// faux à cet instant — il ne bascule qu'au pointerlockchange. Rien ne s'ouvre
// donc en entrant dans la rue.
document.addEventListener('click', (e) => {
  if (TOUCH_MODE || !controls.isLocked || viewerOpen || e.button !== 0) return;
  const mesh = artworkAt(0, 0);
  if (mesh) openViewer(mesh);
});

// ============================================================================
// 14. COMMANDES TACTILES
//     Il n'y a pas de verrouillage de pointeur sur un téléphone, donc pas de
//     viseur au centre : le pouce gauche tient un joystick, le doigt droit
//     balaie l'écran pour regarder, et une tape sur une toile l'ouvre.
//     Chaque doigt est suivi par son pointerId, sinon on ne pourrait pas
//     avancer et regarder en même temps.
//     Tout est inerte hors TOUCH_MODE : rien n'est créé sur un poste fixe.
// ============================================================================
const joystick = new THREE.Vector2(); // x = droite, y = avant, dans [-1, 1]

const TOUCH_CSS = `
html, body { touch-action: none; overscroll-behavior: none;
             -webkit-user-select: none; user-select: none;
             -webkit-tap-highlight-color: transparent; }

.stick { position: fixed; z-index: 6;
         left: calc(22px + env(safe-area-inset-left, 0px));
         bottom: calc(28px + env(safe-area-inset-bottom, 0px));
         width: 116px; height: 116px; border-radius: 50%;
         border: 1px solid rgba(240,217,181,.4);
         background: rgba(13,10,8,.25);
         display: grid; place-items: center;
         opacity: 0; pointer-events: none;
         transition: opacity .3s; }
.stick--on   { opacity: .42; pointer-events: auto; }
.stick--held { opacity: .85; }
.stick__knob { width: 46px; height: 46px; border-radius: 50%;
               background: rgba(240,217,181,.55);
               border: 1px solid rgba(13,10,8,.45);
               will-change: transform; }

.jump { position: fixed; z-index: 6;
        right: calc(24px + env(safe-area-inset-right, 0px));
        bottom: calc(36px + env(safe-area-inset-bottom, 0px));
        width: 76px; height: 76px; border-radius: 50%;
        border: 1px solid rgba(240,217,181,.4);
        background: rgba(13,10,8,.25); color: #f0d9b5;
        font: 15px monospace; letter-spacing: .1em;
        display: grid; place-items: center;
        opacity: 0; pointer-events: none;
        transition: opacity .3s; }
.jump--on { opacity: .42; pointer-events: auto; }
.jump:active { opacity: .85; }

/* Bouton d'ouverture : n'apparaît que lorsqu'une toile est au centre de l'écran.
   Il est donc son propre mode d'emploi — rien à expliquer, il surgit quand il
   sert. Il double la tape directe, qui reste le geste naturel. */
.act { position: fixed; z-index: 7; left: 50%;
       bottom: calc(104px + env(safe-area-inset-bottom, 0px));
       transform: translateX(-50%) translateY(10px);
       display: flex; align-items: center; gap: 12px;
       padding: 12px 20px; border-radius: 999px;
       border: 1px solid rgba(240,217,181,.45);
       background: rgba(13,10,8,.6); color: #f0d9b5;
       font: 12px monospace; letter-spacing: .2em; text-transform: uppercase;
       white-space: nowrap; opacity: 0; pointer-events: none;
       transition: opacity .2s, transform .2s; }
.act--on { opacity: .95; pointer-events: auto; transform: translateX(-50%) translateY(0); }
.act:active { background: rgba(240,217,181,.28); }
.act b { font-weight: normal; }
.act span { opacity: .55; }

/* L'aide d'entrée : visible au premier passage, puis effacée. */
.tip { position: fixed; z-index: 6; left: 0; right: 0;
       bottom: calc(26px + env(safe-area-inset-bottom, 0px));
       text-align: center; padding: 0 24px;
       font: 11px monospace; letter-spacing: .22em; color: #f0d9b5;
       text-shadow: 0 1px 3px #000; opacity: 0; pointer-events: none;
       transition: opacity .5s; }
.tip--on { opacity: .75; }

/* Écran bas (téléphone couché) : on rétrécit pour ne pas manger la vue. */
@media (max-height: 460px) {
  .stick { width: 92px; height: 92px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
  .stick__knob { width: 38px; height: 38px; }
  .jump { width: 62px; height: 62px; bottom: calc(22px + env(safe-area-inset-bottom, 0px)); }
  .act { bottom: calc(88px + env(safe-area-inset-bottom, 0px)); padding: 9px 16px; }
  .tip { bottom: calc(14px + env(safe-area-inset-bottom, 0px)); }
}
`;

let stick = null;
let knob = null;
let tip = null;
let jumpBtn = null;
let actionBtn = null;
let actionTitle = null;

function showTouchUI() {
  if (!stick) return;
  stick.classList.add('stick--on');
  jumpBtn.classList.add('jump--on');
}

function hideTouchUI() {
  if (!stick) return;
  stick.classList.remove('stick--on', 'stick--held');
  jumpBtn.classList.remove('jump--on');
  actionBtn.classList.remove('act--on');
  resetStick();
}

// Appelé par updateAim (section 13) à chaque changement de cible : le bouton
// suit ce qui est au centre de l'écran.
function setActionTarget(mesh) {
  if (!actionBtn) return;
  if (mesh) actionTitle.textContent = mesh.userData.title;
  actionBtn.classList.toggle('act--on', Boolean(mesh) && isPlaying());
}

function resetStick() {
  joystick.set(0, 0);
  if (knob) gsap.to(knob, { x: 0, y: 0, duration: 0.18, ease: 'power2.out' });
}

if (TOUCH_MODE) {
  document.head.appendChild(
    Object.assign(document.createElement('style'), { textContent: TOUCH_CSS })
  );

  stick = document.createElement('div');
  stick.className = 'stick';
  stick.innerHTML = '<i class="stick__knob"></i>';
  document.body.appendChild(stick);
  knob = stick.querySelector('.stick__knob');

  jumpBtn = document.createElement('button');
  jumpBtn.className = 'jump';
  jumpBtn.type = 'button';
  jumpBtn.textContent = 'SAUT';
  jumpBtn.setAttribute('aria-label', 'Sauter');
  document.body.appendChild(jumpBtn);

  // pointerdown, pas click : le saut doit partir à l'instant où le doigt touche.
  jumpBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    tryJump();
  });

  actionBtn = document.createElement('button');
  actionBtn.className = 'act';
  actionBtn.type = 'button';
  actionBtn.innerHTML = '<b></b><span>VOIR</span>';
  document.body.appendChild(actionBtn);
  actionTitle = actionBtn.querySelector('b');

  // click et non pointerdown : un balayage amorcé sur le bouton puis parti
  // ailleurs ne doit pas ouvrir la toile. Le click exige l'appui ET le relâché
  // sur le bouton.
  actionBtn.addEventListener('click', () => {
    if (aimed) openViewer(aimed);
  });

  tip = document.createElement('div');
  tip.className = 'tip';
  tip.textContent = 'POUCE GAUCHE POUR MARCHER · GLISSER POUR REGARDER · TAPER UNE TOILE';
  document.body.appendChild(tip);

  // ---- Joystick -----------------------------------------------------------
  // setPointerCapture : le pouce peut sortir du cercle sans qu'on perde le doigt,
  // ce qui arrive constamment quand on pousse à fond vers le bord de l'écran.
  let stickId = null;

  function updateStick(e) {
    const box = stick.getBoundingClientRect();
    const max = box.width / 2 - 12;
    let dx = e.clientX - (box.left + box.width / 2);
    let dy = e.clientY - (box.top + box.height / 2);

    const dist = Math.hypot(dx, dy);
    if (dist > max) {
      dx = (dx / dist) * max;
      dy = (dy / dist) * max;
    }
    gsap.set(knob, { x: dx, y: dy });
    joystick.set(dx / max, -dy / max); // vers le haut de l'écran = avancer
  }

  stick.addEventListener('pointerdown', (e) => {
    if (!isPlaying()) return;
    e.preventDefault();
    stickId = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    stick.classList.add('stick--held');
    dismissTip();
    updateStick(e);
  });

  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) updateStick(e);
  });

  function releaseStick(e) {
    if (e.pointerId !== stickId) return;
    stickId = null;
    stick.classList.remove('stick--held');
    resetStick();
  }
  stick.addEventListener('pointerup', releaseStick);
  stick.addEventListener('pointercancel', releaseStick);

  // ---- Regard et tape -----------------------------------------------------
  // Même logique que PointerLockControls : un Euler 'YXZ', le lacet sur Y, le
  // tangage sur X borné juste avant la verticale pour ne pas passer par-dessus.
  const canvas = renderer.domElement;
  const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const PITCH_LIMIT = Math.PI / 2 - 0.01;

  let lookId = null;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;

  // Distance à vol d'oiseau depuis le point d'appui — surtout PAS la longueur du
  // trajet cumulée. Un doigt posé qui tremble émet des dizaines de pointermove
  // de 1 ou 2 px : leur somme franchissait le seuil avant même qu'on relâche, et
  // toutes les tapes étaient prises pour des balayages.
  const drift = (e) => Math.hypot(e.clientX - downX, e.clientY - downY);

  function applyLook(dx, dy) {
    lookEuler.setFromQuaternion(camera.quaternion);
    lookEuler.y -= dx * TOUCH.lookSpeed;
    lookEuler.x -= dy * TOUCH.lookSpeed;
    lookEuler.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, lookEuler.x));
    camera.quaternion.setFromEuler(lookEuler);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!isPlaying() || lookId !== null) return;
    // Annule les événements souris de compatibilité que le navigateur émettrait
    // ensuite : c'est la première ligne de défense contre le clic fantôme qui
    // refermait la toile à peine ouverte.
    e.preventDefault();
    lookId = e.pointerId;
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyLook(dx, dy);
    if (drift(e) > TOUCH.tapSlop) dismissTip();
  });

  function endLook(e) {
    if (e.pointerId !== lookId) return;
    lookId = null;
    // Un doigt qui n'a pas dérivé est une tape, pas un balayage : on ouvre la
    // toile qui se trouve sous lui.
    if (drift(e) < TOUCH.tapSlop) {
      const mesh = artworkAtClient(e.clientX, e.clientY);
      if (mesh) {
        dismissTip();
        openViewer(mesh);
      }
    }
  }
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);

  // ---- Aide de premier passage -------------------------------------------
  let tipTimer = null;

  function dismissTip() {
    if (!tip) return;
    clearTimeout(tipTimer);
    tip.classList.remove('tip--on');
  }

  // Une seule fois, à la première entrée réelle dans la rue. Un drapeau plutôt
  // qu'un listener `once` : une tape pendant le chargement n'entre pas encore,
  // et consommerait le `once` sans que l'aide se soit affichée.
  let tipShown = false;
  overlay.addEventListener('click', () => {
    if (tipShown || !isPlaying()) return;
    tipShown = true;
    tip.classList.add('tip--on');
    tipTimer = setTimeout(dismissTip, TOUCH.hintDelay * 1000);
  });
}

// Enregistré ici, tout en bas : la boucle appelle isPlaying() et readMoveInput(),
// qui lisent l'état construit par cette section.
renderer.setAnimationLoop(animate);
