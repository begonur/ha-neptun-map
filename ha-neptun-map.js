class HANeptunMap extends HTMLElement {

  constructor() {
    super();

    this._map = null;
    this._oblastLayer = null;
    this._oblastGeoJSON = null;
    this._client = null;
    this._unsubscribe = null;
    this._animation = null;
    this._resizeObserver = null;

    this._markers = new Map();
    this._clusterMarkers = [];
    this._clusterPool = new Map();
    this._clusterRevision = 0;
    this._oblastLabels = [];
    this._cityLabels = [];

    this._raionLayer = null;
    this._raionBoundaryLayer = null;
    this._raionBoundaryGeoJSON = null;
    this._oblastBorderLayer = null;

    /*
     * Phase 3 performance caches.
     *
     * District -> oblast ownership never changes after GeoJSON load,
     * so do the expensive point-in-polygon lookup once. SVG clip
     * nodes are also kept and only their path geometry is refreshed
     * after Leaflet finishes a zoom.
     */
    this._raionClipAssignments = null;
    this._raionClipDefs = null;
    this._raionClipPaths = new Map();
    this._raionCenterLabels = [];
    this._raionsLoaded = false;

    this._kyivBoundary = null;
    this._kyivBoundaryLoaded = false;

    this._snapshot = {
      threats: [],
      alerts: [],
      alertOblasts: []
    };

    this._selectedThreat = null;
    this._configSet = false;

    this._minimumZoom = 5;
    this._ukraineBounds = null;
    this._ukraineRealBounds = null;

    this._lastIconZoomBucket = null;

    /*
     * Performance state.
     *
     * Leaflet already moves the whole map pane with a compositor
     * transform during drag/pinch. Any marker/cluster DOM rebuild
     * while that gesture is active forces extra main-thread work
     * and is especially expensive in iOS WKWebView.
     */
    this._mapInteracting = false;
    this._clusterPending = false;
    this._clusterRaf = null;

    /*
     * Prediction / clustering scheduler.
     *
     * Moving targets only need work while the card is visible.
     * Clustering is requested only when a predicted position has
     * actually moved far enough to affect the rendered map.
     */
    this._animationLastPrediction = 0;
    this._animationLastCluster = 0;
    this._predictionInterval = 100;
    this._clusterInterval = 350;
    this._clusterMoveEpsilon = 0.000015;
    this._animationVisibilityHandler = null;

    /*
     * Snapshot-derived lookup tables. Rebuilt once per realtime
     * snapshot so polygon styling is O(districts + alerts), not
     * O(districts × alerts) on every style/update pass.
     */
    this._raionAlertLevels = new Map();
    this._oblastAlertLevels = new Map();
  }


  /* =========================================================
     CONFIG
     ========================================================= */

  setConfig(config) {

    if (this._configSet)
      return;

    this._configSet = true;

    this.config = {
      aspect_ratio: 1.65,
      show_status: false,
      show_oblast_names: true,
      show_regional_centers: true,
      ...config
    };

    this.attachShadow({
      mode: "open"
    });

    this.render();

    /*
     * Не запускаємо Leaflet/GeoJSON/NEPTUN синхронно під час
     * створення Lovelace-картки. Спочатку даємо Home Assistant
     * домалювати решту dashboard, а важку ініціалізацію
     * запускаємо у browser idle time.
     */

    this.scheduleStart();
  }


  /* =========================================================
     HTML / CSS
     ========================================================= */

  render() {

    this.shadowRoot.innerHTML = `

      <style>

        :host {
          display:block;
          width:100%;
        }

        ha-card {
          position:relative;
          width:100%;

          aspect-ratio:
            ${this.config.aspect_ratio} / 1;

          min-height:260px;

          overflow:hidden;

          /*
           * Використовуємо стандартну поверхню/рамку HA,
           * щоб NEPTUN-картка виглядала як сусідні картки.
           * Сам #map лишається прозорим.
           */
          background:
            var(--ha-card-background, var(--card-background-color))
            !important;

          box-shadow:
            var(--ha-card-box-shadow, none)
            !important;

          border:
            var(--ha-card-border-width, 1px)
            solid
            var(--ha-card-border-color, var(--divider-color))
            !important;

          border-radius:
            var(--ha-card-border-radius,12px);

          touch-action:manipulation;
        }

        #map {
          position:absolute;
          inset:0;
          width:100%;
          height:100%;
          background:transparent;
        }

        .leaflet-container {
          background:transparent !important;

          font-family:
            var(
              --paper-font-body1_-_font-family,
              Arial,
              sans-serif
            );

          outline:none;

          -webkit-tap-highlight-color:
            transparent;
        }


        /* =====================================================
           ZOOM
           ===================================================== */

        .leaflet-control-zoom {
          border:none !important;

          box-shadow:
            0 2px 8px
            rgba(0,0,0,.38)
            !important;
        }

        .leaflet-control-zoom a {
          width:34px !important;
          height:34px !important;

          line-height:34px !important;

          background:
            rgba(14,21,27,.88)
            !important;

          color:#fff !important;

          border-color:
            rgba(255,255,255,.08)
            !important;

          font-size:20px !important;
          font-weight:500 !important;
        }

        .leaflet-control-zoom a:hover {
          background:
            rgba(35,45,52,.96)
            !important;
        }


        /* =====================================================
           STATUS
           ===================================================== */

        #status {
          position:absolute;

          top:8px;
          right:8px;

          z-index:1000;

          padding:5px 9px;

          border-radius:7px;

          background:
            rgba(8,13,17,.72);

          backdrop-filter:
            blur(7px);

          -webkit-backdrop-filter:
            blur(7px);

          color:#ddd;

          font-size:11px;

          pointer-events:none;

          transition:
            opacity .2s ease;
        }

        #status.hidden {
          opacity:0;
        }


        /* =====================================================
           CREDIT
           ===================================================== */

        #credit {
          position:absolute;

          right:7px;
          bottom:5px;

          z-index:850;

          padding:3px 6px;

          border-radius:5px;

          background:
            rgba(0,0,0,.48);

          backdrop-filter:
            blur(4px);

          -webkit-backdrop-filter:
            blur(4px);

          font-size:9px;
        }

        #credit a {
          color:#bbb;
          text-decoration:none;
        }


        /* =====================================================
           OBLAST LABELS
           ===================================================== */

        .oblast-label-wrapper {
          pointer-events:none !important;
          background:none !important;
          border:none !important;
        }

        .oblast-label {
          position:absolute;

          left:50%;
          top:50%;

          transform:
            translate(-50%,-50%);

          box-sizing:border-box;

          display:flex;

          align-items:center;
          justify-content:center;

          text-align:center;

          white-space:normal;

          overflow:visible;

          overflow-wrap:normal;

          word-break:normal;

          color:
            rgba(255,255,255,.99);

          font-size:8px;
          line-height:1.12;

          font-weight:700;

          letter-spacing:-0.1px;

          text-shadow:
            -1px -1px 0 rgba(0,0,0,.72),
             1px -1px 0 rgba(0,0,0,.72),
            -1px  1px 0 rgba(0,0,0,.72),
             1px  1px 0 rgba(0,0,0,.72),
             0    0   3px rgba(0,0,0,1);

          pointer-events:none;

          user-select:none;

          transition:
            font-size .15s ease,
            opacity .15s ease;

          opacity:.9;

          padding:1px 2px;
          border-radius:3px;
        }


        /* =====================================================
           REGIONAL CENTER
           ===================================================== */

        .city-label-wrapper {
          pointer-events:none !important;
          background:none !important;
          border:none !important;
        }

        .city-label {
          position:absolute;

          left:50%;
          top:50%;

          display:flex;

          align-items:center;

          transform:
            translate(0,-50%);

          gap:2px;

          white-space:nowrap;

          pointer-events:none;

          user-select:none;

          color:
            rgba(255,255,255,.99);

          font-size:7px;

          line-height:1;

          font-weight:700;

          text-shadow:
            -1px -1px 0 rgba(0,0,0,.78),
             1px -1px 0 rgba(0,0,0,.78),
            -1px  1px 0 rgba(0,0,0,.78),
             1px  1px 0 rgba(0,0,0,.78),
             0    0   3px rgba(0,0,0,1);

          transition:
            font-size .15s ease,
            opacity .15s ease;
        }

        .city-dot {
          flex:0 0 auto;

          width:3px;
          height:3px;

          margin-right:1px;

          border-radius:50%;

          background:
            rgba(235,240,243,.88);

          box-shadow:
            0 0 2px
            rgba(0,0,0,1);
        }

        .city-name {
          display:block;

          padding:1px 2px;

          border-radius:3px;

          background:
            rgba(8,12,16,.30);

          transition:
            opacity .12s ease;
        }

        .city-name.label-hidden {
          opacity:0 !important;
        }


        /*
         * LIGHT THEME
         *
         * На світлій темі темні тіні навколо підписів давали
         * "брудний" ореол. Міняємо тільки читабельність карти;
         * кольори цілей та інформаційної панелі не чіпаємо.
         */

        /*
         * У світлій темі підписи робимо чорними з товстим
         * білим halo. Так вони залишаються темними на світлих
         * областях, а білий контур відділяє текст від red/yellow.
         * Плашки навмисно прибрані — карта лишається чистою.
         */

        .oblast-label.label-light {
          color:#111820 !important;

          font-weight:700;

          background:transparent !important;

          text-shadow:
            -1px -1px 0 rgba(255,255,255,.95),
             1px -1px 0 rgba(255,255,255,.95),
            -1px  1px 0 rgba(255,255,255,.95),
             1px  1px 0 rgba(255,255,255,.95),
             0    0   3px rgba(255,255,255,1);

          box-shadow:none;
        }

        .city-label.label-light {
          color:#111820 !important;

          font-weight:700;

          text-shadow:
            -1px -1px 0 rgba(255,255,255,.98),
             1px -1px 0 rgba(255,255,255,.98),
            -1px  1px 0 rgba(255,255,255,.98),
             1px  1px 0 rgba(255,255,255,.98),
             0    0   3px rgba(255,255,255,1);
        }

        .city-label.label-light .city-dot {
          background:#111820;

          box-shadow:
            0 0 0 1px rgba(255,255,255,.95),
            0 0 3px rgba(255,255,255,1);
        }

        .city-label.label-light .city-name {
          background:transparent !important;

          box-shadow:none;
        }


        .raion-center-wrapper {
          background:transparent !important;
          border:none !important;
          overflow:visible !important;
          pointer-events:none !important;
        }

        .raion-center-label {
          display:flex;
          align-items:center;
          gap:3px;
          width:max-content;
          white-space:nowrap;
          font-size:7.5px;
          font-weight:700;
          line-height:1;
          opacity:.92;
        }

        .raion-center-dot {
          display:block;
          width:3px;
          height:3px;
          flex:0 0 3px;
          border-radius:50%;
          background:currentColor;
          box-shadow:0 0 0 1px rgba(0,0,0,.45);
        }

        .raion-center-name {
          display:block;
        }


        /* =====================================================
           THREATS
           ===================================================== */

        .threat-hitbox {
          position:relative;

          width:50px;
          height:50px;

          display:flex;

          align-items:center;
          justify-content:center;

          cursor:pointer;

          -webkit-tap-highlight-color:
            transparent;

          user-select:none;
        }

        .threat-symbol {
          position:relative;

          display:flex;

          align-items:center;
          justify-content:center;

          transform-origin:
            50% 50%;

          transition:
            width .15s ease,
            height .15s ease;

          filter:
            drop-shadow(
              0 1px 2px
              rgba(0,0,0,.95)
            );
        }

        .threat-symbol svg {
          display:block;

          width:100%;
          height:100%;

          overflow:visible;

          fill:currentColor;

          stroke:
            rgba(0,0,0,.90);

          stroke-width:1.5;

          stroke-linejoin:round;
          stroke-linecap:round;
        }

        .threat-count {
          position:absolute;

          z-index:5;

          min-width:16px;
          height:16px;

          padding:0 4px;

          box-sizing:border-box;

          border-radius:9px;

          background:#e53935;

          border:
            1px solid
            rgba(255,255,255,.35);

          color:#fff;

          font-size:9px;
          font-weight:700;
          line-height:14px;
          text-align:center;

          box-shadow:
            0 1px 4px
            rgba(0,0,0,.85);

          top:4px;
          right:1px;
        }

        .area-threat {
          display:flex;
          align-items:center;
          justify-content:center;

          width:max-content;
          max-width:none;

          box-sizing:border-box;

          padding:4px 7px;

          border-radius:6px;

          background:
            rgba(20,27,32,.92);

          color:#fff;

          font-size:10px;
          font-weight:600;
          line-height:1.2;

          white-space:nowrap;

          box-shadow:
            0 2px 6px
            rgba(0,0,0,.65);
        }


        /* =====================================================
           INFO PANEL
           ===================================================== */

        #info-panel {
          position:absolute;

          z-index:2000;

          left:50%;
          bottom:12px;

          width:
            min(
              calc(100% - 24px),
              360px
            );

          max-width:360px;

          box-sizing:border-box;

          margin:0;

          padding:
            13px
            48px
            13px
            14px;

          transform:
            translate(-50%,16px);

          opacity:0;
          visibility:hidden;

          pointer-events:none;

          border:
            1px solid
            rgba(255,255,255,.12);

          border-radius:13px;

          background:
            rgba(15,21,26,.97);

          backdrop-filter:
            blur(12px);

          -webkit-backdrop-filter:
            blur(12px);

          color:#f2f2f2;

          box-shadow:
            0 7px 24px
            rgba(0,0,0,.55);

          transition:
            opacity .15s ease,
            transform .15s ease,
            visibility .15s ease;
        }

        #info-panel.open {
          opacity:1;
          visibility:visible;
          pointer-events:auto;

          transform:
            translate(-50%,0);
        }

        #info-close {
          position:absolute;

          top:4px;
          right:4px;

          width:40px;
          height:40px;

          margin:0;
          padding:0;

          display:flex;

          align-items:center;
          justify-content:center;

          border:0;

          border-radius:50%;

          background:transparent;

          color:#aaa;

          font-family:Arial,sans-serif;

          font-size:24px;
          font-weight:400;

          line-height:1;

          cursor:pointer;

          touch-action:manipulation;

          -webkit-tap-highlight-color:
            transparent;
        }

        #info-close:hover,
        #info-close:active {
          color:#fff;

          background:
            rgba(255,255,255,.08);
        }

        .info-title {
          padding:0;
          margin:0;

          color:#fff;

          font-size:15px;

          line-height:1.25;

          font-weight:700;
        }

        .info-location {
          margin-top:5px;

          color:#c5cbd0;

          font-size:12px;

          line-height:1.35;
        }

        .info-grid {
          display:flex;

          flex-wrap:wrap;

          gap:4px 12px;

          margin-top:7px;
        }

        .info-item {
          color:#bfc6cb;

          font-size:11px;

          line-height:1.35;
        }

        .info-item b {
          color:#f0f0f0;
          font-weight:600;
        }

        .info-description {
          margin-top:9px;

          padding-top:8px;

          border-top:
            1px solid
            rgba(255,255,255,.12);

          color:#e0e3e5;

          font-size:12px;

          line-height:1.4;

          overflow-wrap:anywhere;
        }

        .info-area-note {
          margin-top:7px;

          color:#9fa8ae;

          font-size:10px;

          line-height:1.35;
        }


        /* =====================================================
           MOBILE
           ===================================================== */

        @media
        (max-width:600px),
        (pointer:coarse) {

          ha-card {
            min-height:
              clamp(
                260px,
                58vw,
                330px
              );
          }

          .leaflet-control-zoom a {
            width:40px !important;
            height:40px !important;

            line-height:40px !important;

            font-size:23px !important;
          }

          .threat-hitbox {
            width:50px;
            height:50px;
          }

          #info-panel {
            left:8px;
            right:8px;
            bottom:8px;

            width:auto;
            max-width:none;

            /*
             * На смартфоні опис загрози часто переноситься
             * на 2 рядки. Старі 230px стискали панель і
             * нижній рядок підходив впритул до її межі.
             */
            max-height:
              min(
                62%,
                320px
              );

            margin:0;

            padding:
              14px
              48px
              14px
              14px;

            overflow-y:auto;
            overflow-x:hidden;

            transform:
              translateY(14px);

            border-radius:14px;
          }

          #info-panel.open {
            transform:
              translateY(0);
          }

          #info-close {
            position:absolute;

            top:4px;
            right:4px;

            float:none;

            width:40px;
            height:40px;

            margin:0;
          }

          .oblast-label {
            text-shadow:
              0 1px 2px #000,
              0 0 3px #000;
          }

          .city-label {
            text-shadow:
              0 1px 2px #000,
              0 0 3px #000;
          }

          .info-title {
            font-size:15px;
          }

          .info-location {
            font-size:12px;
          }

          .info-description {
            font-size:12px;
          }

          .info-item {
            font-size:11px;
          }
        }


        @media (max-width:380px) {

          ha-card {
            min-height:260px;
          }

          #info-panel {
            left:6px;
            right:6px;
            bottom:6px;

            max-height:52%;
          }
        }

      </style>


      <ha-card>

        <div id="map"></div>

        <div id="status">
          NEPTUN: запуск…
        </div>

        <div
          id="info-panel"
          role="dialog"
          aria-live="polite"
        >

          <button
            id="info-close"
            type="button"
            aria-label="Закрити"
          >
            ×
          </button>

          <div id="info-content"></div>

        </div>

        <div id="credit">

          <a
            href="https://neptun.in.ua/"
            target="_blank"
            rel="noopener"
          >
            Дані: NEPTUN
          </a>

        </div>

      </ha-card>
    `;


    this.shadowRoot
      .querySelector("#info-close")
      .addEventListener(
        "click",
        e => {

          e.stopPropagation();

          this.closeInfo();
        }
      );
  }


  /* =========================================================
     START
     ========================================================= */

  scheduleStart() {

    if (this._startScheduled)
      return;


    this._startScheduled = true;


    /*
     * requestIdleCallback сам по собі тут недостатній:
     * під час побудови Lovelace браузер може вважати коротку
     * паузу "idle" і запустити NEPTUN ще ДО того, як HA
     * закінчив малювати решту dashboard.
     *
     * Тому спочатку даємо Home Assistant гарантоване вікно
     * для стартового рендера, і лише потім просимо idle slot.
     */

    setTimeout(
      () => {

        const run =
          () => {

            requestAnimationFrame(
              () => {

                requestAnimationFrame(
                  () => {

                    this._startScheduled = false;

                    if (
                      this.isConnected &&
                      !this._map
                    )
                      this.start();
                  }
                );
              }
            );
          };


        if (
          "requestIdleCallback"
          in window
        ) {

          window.requestIdleCallback(
            run,
            {
              timeout:2000
            }
          );

        }

        else {

          run();
        }
      },
      1500
    );
  }


  async start() {

    try {

      this.status(
        "Завантаження карти…"
      );

      await this.loadLeaflet();

      this.createMap();


      /*
       * Віддаємо main thread браузеру між важкими етапами.
       * Це прибирає відчуття, що NEPTUN затримує всі інші cards.
       */

      await new Promise(
        resolve =>
          requestAnimationFrame(
            () => resolve()
          )
      );


      await this.loadUkraine();


      await new Promise(
        resolve =>
          requestAnimationFrame(
            () => resolve()
          )
      );


      this.status(
        "NEPTUN: підключення…"
      );

      await this.loadSDK();

      this.connectNeptun();

    }

    catch(e) {

      console.error(
        "NEPTUN CARD:",
        e
      );

      this.status(
        "Помилка: " +
        (e.message || e)
      );
    }
  }


  /* =========================================================
     LEAFLET
     ========================================================= */

  async loadLeaflet() {

    if (
      !this.shadowRoot.querySelector(
        'link[data-neptun-leaflet]'
      )
    ) {

      const css =
        document.createElement(
          "link"
        );

      css.rel =
        "stylesheet";

      css.href =
        "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";

      css.setAttribute(
        "data-neptun-leaflet",
        "1"
      );

      /*
       * CSS вантажимо паралельно. Карта не повинна блокувати
       * dashboard лише через очікування зовнішнього stylesheet.
       */

      this.shadowRoot.appendChild(
        css
      );
    }

    if (window.L)
      return;

    await new Promise(
      (resolve,reject) => {

        const script =
          document.createElement(
            "script"
          );

        script.src =
          "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

        script.onload =
          resolve;

        script.onerror =
          () => reject(
            new Error(
              "Leaflet JS"
            )
          );

        document.head.appendChild(
          script
        );
      }
    );
  }


  createMap() {

    const element =
      this.shadowRoot
        .querySelector("#map");


    this._map =
      L.map(
        element,
        {
          zoomControl:false,
          attributionControl:false,

          minZoom:4,
          maxZoom:11,

          zoomSnap:0.25,
          zoomDelta:0.5,

          wheelPxPerZoomLevel:90,

          maxBoundsViscosity:1.0,

          dragging:true,
          touchZoom:true,
          doubleClickZoom:true,
          scrollWheelZoom:true,

          boxZoom:false,
          keyboard:false,
          tap:true
        }
      );


    /*
     * Окремі panes.
     *
     * Області < написи < міста < цілі.
     */

    this._map.createPane(
      "raions"
    );

    this._map.getPane(
      "raions"
    ).style.zIndex = 415;


    this._map.createPane(
      "oblastBorders"
    );

    this._map.getPane(
      "oblastBorders"
    ).style.zIndex = 421;

    this._map.getPane(
      "oblastBorders"
    ).style.pointerEvents = "none";


    this._map.createPane(
      "raionLabels"
    );

    this._map.getPane(
      "raionLabels"
    ).style.zIndex = 425;

    this._map.getPane(
      "raionLabels"
    ).style.pointerEvents = "none";


    this._map.createPane(
      "oblastLabels"
    );

    this._map.getPane(
      "oblastLabels"
    ).style.zIndex = 430;


    this._map.createPane(
      "cityLabels"
    );

    this._map.getPane(
      "cityLabels"
    ).style.zIndex = 440;


    this._map.createPane(
      "kyivBoundary"
    );

    this._map.getPane(
      "kyivBoundary"
    ).style.zIndex = 420;

    this._map.getPane(
      "kyivBoundary"
    ).style.pointerEvents = "none";


    this._map.createPane(
      "threats"
    );

    this._map.getPane(
      "threats"
    ).style.zIndex = 650;


    this._map.setView(
      [48.5,31.2],
      5.5
    );


    this._map.on(
      "click",
      () => {

        this.closeInfo();
      }
    );


    /*
     * During drag/pinch/zoom the map must be compositor-only.
     * We deliberately suspend prediction/clustering and all
     * expensive label/GeoJSON work until Leaflet finishes the
     * interaction. This is critical for iOS WKWebView and also
     * prevents this card from stealing frames from Lovelace.
     */

    const beginInteraction =
      () => {

        this._mapInteracting = true;
      };


    const finishInteraction =
      forceIcons => {

        this._mapInteracting = false;

        this.updateThreatAppearance(
          forceIcons
        );

        this.updateMapLabels();
        this.updateRaionDisplay();
        this.updateKyivBoundary();

        requestAnimationFrame(
          () => {

            if (
              !this._map ||
              this._mapInteracting
            )
              return;

            this.applyRaionOblastClip();
          }
        );
      };


    this._map.on(
      "movestart zoomstart dragstart",
      beginInteraction
    );


    this._map.on(
      "zoomend",
      () => {

        finishInteraction(true);
      }
    );


    this._map.on(
      "moveend",
      () => {

        /*
         * zoomend is followed by moveend in common Leaflet zoom
         * paths. Running the full expensive pipeline twice is
         * unnecessary; updateThreatAppearance() coalesces the
         * clustering pass and the remaining work is cheap enough
         * to run once after the final move event.
         */

        finishInteraction(false);
      }
    );


    this._resizeObserver =
      new ResizeObserver(
        () => {

          if (!this._map)
            return;

          this._map.invalidateSize({
            animate:false
          });

          this.updateMinimumZoom();

          this.updateThreatAppearance(
            true
          );

          this.updateMapLabels();
        }
      );


    this._resizeObserver.observe(
      element
    );


    setTimeout(
      () => {

        if (!this._map)
          return;

        this._map.invalidateSize({
          animate:false
        });

        this.updateMinimumZoom();

        this.updateThreatAppearance(
          true
        );

        this.updateMapLabels();

      },
      250
    );
  }


  /* =========================================================
     GEOJSON
     ========================================================= */

  async loadUkraine() {

    const URL =
      "https://cdn.jsdelivr.net/gh/darmat1/ukraine-geo-data@main/geodata/Ukraine.geojson";


    let geojson = null;


    try {

      const cached =
        localStorage.getItem(
          "neptun_ukraine_geojson_v1"
        );

      if (cached) {

        geojson =
          JSON.parse(
            cached
          );
      }

    }
    catch(e) {}


    if (!geojson) {

      const response =
        await fetch(
          URL
        );

      if (!response.ok) {

        throw new Error(
          "GeoJSON HTTP " +
          response.status
        );
      }

      geojson =
        await response.json();


      try {

        localStorage.setItem(
          "neptun_ukraine_geojson_v1",
          JSON.stringify(
            geojson
          )
        );

      }
      catch(e) {}
    }


    /*
     * Зберігаємо еталонну геометрію областей. Після створення
     * районного SVG шару використаємо її як clipPath.
     */
    this._oblastGeoJSON = geojson;


    this._oblastLayer =
      L.geoJSON(
        geojson,
        {

          style:
            feature =>
              this.oblastStyle(
                feature
              ),

          onEachFeature:
            (feature,layer) =>
              this.setupOblast(
                feature,
                layer
              )
        }
      )
      .addTo(
        this._map
      );


    /*
     * Окремий контур областей поверх районної заливки.
     * Районний alert layer лежить вище основного oblast layer,
     * тому без цього кольорова заливка перекривала межі областей.
     */

    this._oblastBorderLayer =
      L.geoJSON(
        geojson,
        {
          pane:"oblastBorders",
          interactive:false,

          style:() => ({
            color:
              this.isLightTheme()
                ? "rgba(62,75,84,.82)"
                : "rgba(224,234,239,.76)",

            /*
             * Контур області є еталонним і малюється поверх районів.
             * Трохи ширший stroke перекриває дрібне розходження
             * зовнішніх районних меж без зміни самої alert-заливки.
             */

            weight:1.05,
            opacity:1,
            lineJoin:"round",
            lineCap:"round",
            fill:false,
            fillOpacity:0
          })
        }
      )
      .addTo(
        this._map
      );


    this._ukraineRealBounds =
      this._oblastLayer
        .getBounds();


    if (
      this._ukraineRealBounds
        .isValid()
    ) {

      this._ukraineBounds =
        this._ukraineRealBounds
          .pad(0.045);


      this._map.setMaxBounds(
        this._ukraineBounds
      );


      this._map.options
        .maxBoundsViscosity = 1.0;


      this.fitUkraine();
    }


    /*
     * Створюємо географічні підписи
     * тільки після завантаження областей.
     */

    this.createOblastLabels();

    this.createRegionalCenters();

    /*
     * Райони вантажимо окремим шаром. Їх заливка потрібна
     * вже на мінімальному zoom, а межі/центри покажемо лише
     * при наближенні.
     */
    this.loadRaions();

    this.loadKyivBoundary();


    /*
     * Даємо Leaflet один кадр,
     * щоб DOM-маркери вже існували.
     */

    requestAnimationFrame(
      () => {

        this.updateMapLabels();
        this.updateRaionDisplay();
      }
    );
  }


  fitUkraine() {

    if (
      !this._map ||
      !this._ukraineRealBounds
    )
      return;


    this._map.fitBounds(
      this._ukraineRealBounds,
      {
        padding:[
          10,
          10
        ],

        animate:false
      }
    );


    this._minimumZoom =
      this._map.getZoom();


    this._map.setMinZoom(
      this._minimumZoom
    );
  }


  updateMinimumZoom() {

    if (
      !this._map ||
      !this._ukraineRealBounds
    )
      return;


    const zoom =
      this._map.getBoundsZoom(
        this._ukraineRealBounds,
        false,
        [
          10,
          10
        ]
      );


    this._minimumZoom =
      zoom;


    this._map.setMinZoom(
      zoom
    );


    if (
      this._map.getZoom() <
      zoom
    ) {

      this.fitUkraine();
    }
  }


  /* =========================================================
     OBLASTS
     ========================================================= */

  getOblastName(feature) {

    const p =
      feature?.properties || {};


    return (
      p.name_uk ||
      p.name_ua ||
      p.name ||
      p.NAME_1 ||
      p.ADM1_UA ||
      p.ADM1_EN ||
      p.oblast ||
      ""
    );
  }


  normalizeName(name) {

    return String(
      name || ""
    )

      .toLowerCase()

      .replaceAll(
        "’",
        "'"
      )

      .replaceAll(
        "ʼ",
        "'"
      )

      .replace(
        /\s+область$/i,
        ""
      )

      .replace(
        /^автономна республіка\s+/i,
        ""
      )

      .replace(
        /^ар\s+/i,
        ""
      )

      .trim();
  }


  displayOblastName(name) {

    let n =
      String(name || "")
        .trim();


    n = n.replace(
      /\s+область$/i,
      ""
    );


    n = n.replace(
      /^автономна республіка\s+крим$/i,
      "АР Крим"
    );


    if (
      /^крим$/i.test(n)
    ) {

      n = "АР Крим";
    }


    return n;
  }


  getOblastAlertLevel(feature) {

    const featureName =
      this.normalizeName(
        this.getOblastName(
          feature
        )
      );


    if (!featureName)
      return null;


    /*
     * Районні alerts більше НЕ агрегуємо до області.
     * Область фарбується лише за окремим alertOblasts fallback.
     * Основний рівень тривоги тепер відображає районний шар.
     */

    let level = null;


    /*
     * Старий/агрегований alertOblasts лишаємо fallback.
     * Якщо рівень там відсутній, трактуємо запис як red,
     * щоб не втратити тривогу на старішій версії SDK.
     */

    for (
      const alert
      of (
        this._snapshot
          .alertOblasts || []
      )
    ) {

      const name =
        typeof alert === "string"

          ? alert

          : (
              alert.oblast ||
              alert.region ||
              alert.name ||
              ""
            );


      const alertName =
        this.normalizeName(
          name
        );


      if (
        !alertName ||
        !(
          alertName === featureName ||
          alertName.includes(featureName) ||
          featureName.includes(alertName)
        )
      )
        continue;


      const alertLevel =
        String(
          alert?.level || ""
        )
          .toLowerCase()
          .trim();


      if (alertLevel === "red")
        return "red";


      if (alertLevel === "yellow") {

        level = "yellow";

      }

      else if (!level) {

        return "red";
      }
    }


    return level;
  }


  isOblastAlert(feature) {

    return !!this.getOblastAlertLevel(
      feature
    );
  }


  parseCssColor(value) {

    if (!value)
      return null;


    const probe =
      document.createElement(
        "span"
      );


    probe.style.color =
      value;


    probe.style.display =
      "none";


    this.shadowRoot
      .appendChild(
        probe
      );


    const resolved =
      getComputedStyle(
        probe
      ).color;


    probe.remove();


    const match =
      resolved.match(
        /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/
      );


    if (!match)
      return null;


    return [
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    ];
  }


  colorLuminance(rgb) {

    if (!rgb)
      return null;


    const linear =
      rgb.map(
        value => {

          const c =
            value / 255;


          return c <= .04045
            ? c / 12.92
            : Math.pow(
                (c + .055) / 1.055,
                2.4
              );
        }
      );


    return (
      .2126 * linear[0] +
      .7152 * linear[1] +
      .0722 * linear[2]
    );
  }


  isLightTheme() {

    const styles =
      getComputedStyle(
        this
      );


    /*
     * --dark-mode лишаємо першим сигналом, якщо тема HA
     * задає його коректно.
     */

    const darkMode =
      styles
        .getPropertyValue(
          "--dark-mode"
        )
        .trim();


    if (darkMode === "0")
      return true;


    if (darkMode === "1")
      return false;


    /*
     * Mushroom та інші кастомні теми часто використовують
     * hex / hsl / CSS variables замість rgb(). Старий regex
     * їх не розумів і помилково падав у dark.
     *
     * Тепер браузер сам резолвить CSS-колір, а ми визначаємо
     * тему насамперед за ФОНОМ картки, не за кольором тексту.
     */

    const candidates = [
      "--ha-card-background",
      "--card-background-color",
      "--primary-background-color"
    ];


    for (
      const variable
      of candidates
    ) {

      const value =
        styles
          .getPropertyValue(
            variable
          )
          .trim();


      if (!value)
        continue;


      const luminance =
        this.colorLuminance(
          this.parseCssColor(
            value
          )
        );


      if (luminance !== null)
        return luminance > .45;
    }


    /*
     * Останній fallback: темний primary text зазвичай означає
     * світлий фон.
     */

    const textLuminance =
      this.colorLuminance(
        this.parseCssColor(
          styles
            .getPropertyValue(
              "--primary-text-color"
            )
            .trim()
        )
      );


    if (textLuminance !== null)
      return textLuminance < .45;


    return false;
  }


  applyThemeClass() {

    const card =
      this.shadowRoot
        ?.querySelector(
          "ha-card"
        );


    if (!card)
      return;


    card.classList.toggle(
      "light-theme",
      this.isLightTheme()
    );
  }


  mapPalette() {

    this.applyThemeClass();


    if (this.isLightTheme()) {

      return {

        normalStroke:"#687783",
        normalFill:"#dce3e7",

        redStroke:"#b93f51",
        redFill:"#8f4350",

        yellowStroke:"#d6a900",
        yellowFill:"#c79a18"
      };
    }


    return {

      normalStroke:
        "rgba(190,205,215,.78)",

      normalFill:"#263840",

      redStroke:"#d65a68",
      redFill:"#71323d",

      yellowStroke:"#d7a94a",
      yellowFill:"#665329"
    };
  }


  oblastStyle(feature) {

    const level =
      this.getOblastAlertLevel(
        feature
      );


    const palette =
      this.mapPalette();


    if (level === "red") {

      return {

        color:palette.redStroke,

        weight:1.5,

        opacity:1,

        fillColor:palette.redFill,

        fillOpacity:1
      };
    }


    if (level === "yellow") {

      return {

        color:palette.yellowStroke,

        weight:1.5,

        opacity:1,

        fillColor:palette.yellowFill,

        fillOpacity:1
      };
    }


    return {

      color:palette.normalStroke,

      weight:1,

      opacity:.9,

      fillColor:palette.normalFill,

      fillOpacity:
        this.isLightTheme()
          ? .92
          : .34
    };
  }


  /*
   * Старий Leaflet bindTooltip тут
   * спеціально НЕ використовується.
   *
   * Саме він давав білу плашку
   * при тапі по області.
   */

  setupOblast(
    feature,
    layer
  ) {

    layer.on({

      mouseover:e => {

        e.target.setStyle({

          weight:2,

          fillOpacity:
            this.isOblastAlert(
              feature
            )
              ? .67
              : .46
        });
      },


      mouseout:e => {

        e.target.setStyle(
          this.oblastStyle(
            feature
          )
        );
      }

    });
  }


  refreshOblasts() {

    if (!this._oblastLayer)
      return;


    this._oblastLayer.eachLayer(
      layer => {

        layer.setStyle(
          this.oblastStyle(
            layer.feature
          )
        );
      }
    );
  }


  /* =========================================================
     POLYGON / LABEL HELPERS
     ========================================================= */

  pointInRing(lon, lat, ring) {

    let inside = false;

    for (
      let i = 0, j = ring.length - 1;
      i < ring.length;
      j = i++
    ) {

      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];

      const crosses =
        ((yi > lat) !== (yj > lat)) &&
        (
          lon <
          (xj - xi) *
          (lat - yi) /
          ((yj - yi) || 1e-12) +
          xi
        );

      if (crosses)
        inside = !inside;
    }

    return inside;
  }


  pointInPolygonCoordinates(lon, lat, polygon) {

    if (
      !polygon ||
      !polygon.length ||
      !this.pointInRing(
        lon,
        lat,
        polygon[0]
      )
    )
      return false;

    for (
      let i = 1;
      i < polygon.length;
      i++
    ) {

      if (
        this.pointInRing(
          lon,
          lat,
          polygon[i]
        )
      )
        return false;
    }

    return true;
  }


  pointInFeature(latlng, feature) {

    const geometry =
      feature?.geometry;

    if (!geometry)
      return false;

    const lon = latlng.lng;
    const lat = latlng.lat;

    if (
      geometry.type ===
      "Polygon"
    ) {

      return this.pointInPolygonCoordinates(
        lon,
        lat,
        geometry.coordinates
      );
    }

    if (
      geometry.type ===
      "MultiPolygon"
    ) {

      return geometry.coordinates.some(
        polygon =>
          this.pointInPolygonCoordinates(
            lon,
            lat,
            polygon
          )
      );
    }

    return false;
  }


  distanceToFeatureEdges(latlng, feature) {

    if (
      !this._map ||
      !feature?.geometry
    )
      return 0;

    const p =
      this._map.latLngToContainerPoint(
        latlng
      );

    let best = Infinity;

    const distanceToRing =
      ring => {

        for (
          let i = 0;
          i < ring.length - 1;
          i++
        ) {

          const a =
            this._map.latLngToContainerPoint(
              [
                ring[i][1],
                ring[i][0]
              ]
            );

          const b =
            this._map.latLngToContainerPoint(
              [
                ring[i + 1][1],
                ring[i + 1][0]
              ]
            );

          const dx = b.x - a.x;
          const dy = b.y - a.y;

          const len2 =
            dx * dx +
            dy * dy;

          let t =
            len2
              ? (
                  (
                    (p.x - a.x) * dx +
                    (p.y - a.y) * dy
                  ) /
                  len2
                )
              : 0;

          t =
            Math.max(
              0,
              Math.min(
                1,
                t
              )
            );

          const x =
            a.x +
            t * dx;

          const y =
            a.y +
            t * dy;

          best =
            Math.min(
              best,
              Math.hypot(
                p.x - x,
                p.y - y
              )
            );
        }
      };

    const g =
      feature.geometry;

    if (
      g.type ===
      "Polygon"
    ) {

      g.coordinates.forEach(
        distanceToRing
      );
    }

    else if (
      g.type ===
      "MultiPolygon"
    ) {

      g.coordinates.forEach(
        polygon =>
          polygon.forEach(
            distanceToRing
          )
      );
    }

    return Number.isFinite(best)
      ? best
      : 0;
  }


  getLayerCenter(layer) {

    if (
      !this._map ||
      !layer?.feature
    ) {

      try {

        return layer
          .getBounds()
          .getCenter();

      }
      catch(e) {

        return null;
      }
    }


    const bounds =
      layer.getBounds();

    let best = null;
    let bestScore = -1;

    /*
     * Шукаємо не геометричний центр bounds,
     * а точку, яка реально лежить усередині
     * області та максимально віддалена від
     * її контуру. Для підписів це значно
     * стабільніше на вузьких областях.
     */

    const search =
      (
        center,
        latSpan,
        lonSpan,
        steps
      ) => {

        for (
          let y = 0;
          y <= steps;
          y++
        ) {

          for (
            let x = 0;
            x <= steps;
            x++
          ) {

            const lat =
              center.lat -
              latSpan / 2 +
              latSpan * y / steps;

            const lng =
              center.lng -
              lonSpan / 2 +
              lonSpan * x / steps;

            const candidate =
              L.latLng(
                lat,
                lng
              );

            if (
              !this.pointInFeature(
                candidate,
                layer.feature
              )
            )
              continue;

            const score =
              this.distanceToFeatureEdges(
                candidate,
                layer.feature
              );

            if (
              score >
              bestScore
            ) {

              bestScore =
                score;

              best =
                candidate;
            }
          }
        }
      };


    const initialCenter =
      bounds.getCenter();

    let latSpan =
      bounds.getNorth() -
      bounds.getSouth();

    let lonSpan =
      bounds.getEast() -
      bounds.getWest();


    search(
      initialCenter,
      latSpan,
      lonSpan,
      10
    );


    for (
      let pass = 0;
      pass < 3 && best;
      pass++
    ) {

      latSpan /= 4;
      lonSpan /= 4;

      search(
        best,
        latSpan,
        lonSpan,
        8
      );
    }


    if (best)
      return best;


    try {

      if (
        typeof layer.getCenter ===
        "function"
      )
        return layer.getCenter();
    }
    catch(e) {}


    return bounds.getCenter();
  }

  getOblastLabelWidth(layer) {

    if (
      !this._map ||
      !layer
    )
      return 60;


    try {

      const bounds =
        layer.getBounds();


      const nw =
        this._map.latLngToContainerPoint(
          bounds.getNorthWest()
        );


      const se =
        this._map.latLngToContainerPoint(
          bounds.getSouthEast()
        );


      const width =
        Math.abs(
          se.x -
          nw.x
        );


      /*
       * Не дозволяємо назві області
       * займати всю ширину її bounding box.
       *
       * Це особливо важливо для вузьких
       * західних областей.
       */

      return Math.max(
        34,
        Math.min(
          125,
          width * .68
        )
      );

    }

    catch(e) {

      return 60;
    }
  }


  /*
   * Повертає приблизний екранний rectangle
   * для елемента.
   *
   * Використовуємо його для collision detection.
   */

  getElementRect(el) {

    if (!el)
      return null;


    const rect =
      el.getBoundingClientRect();


    if (
      !rect ||
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top)
    )
      return null;


    return {

      left:rect.left,

      top:rect.top,

      right:rect.right,

      bottom:rect.bottom,

      width:rect.width,

      height:rect.height
    };
  }


  /*
   * Трохи розширюємо rectangle,
   * щоб написи не стояли впритул.
   */

  padRect(
    rect,
    padding = 2
  ) {

    if (!rect)
      return null;


    return {

      left:
        rect.left -
        padding,

      top:
        rect.top -
        padding,

      right:
        rect.right +
        padding,

      bottom:
        rect.bottom +
        padding,

      width:
        rect.width +
        padding * 2,

      height:
        rect.height +
        padding * 2
    };
  }


  rectsIntersect(
    a,
    b
  ) {

    if (
      !a ||
      !b
    )
      return false;


    return !(
      a.right <
        b.left ||

      a.left >
        b.right ||

      a.bottom <
        b.top ||

      a.top >
        b.bottom
    );
  }


  rectIntersectsAny(
    rect,
    occupied
  ) {

    if (!rect)
      return false;


    for (
      const other
      of occupied
    ) {

      if (
        this.rectsIntersect(
          rect,
          other
        )
      ) {

        return true;
      }
    }


    return false;
  }


  /* =========================================================
     OBLAST LABELS
     ========================================================= */

  createOblastLabels() {

    if (
      !this.config.show_oblast_names ||
      !this._oblastLayer
    )
      return;


    for (
      const item
      of this._oblastLabels
    ) {

      try {

        item.marker.remove();

      }
      catch(e) {}
    }


    this._oblastLabels = [];


    this._oblastLayer.eachLayer(
      layer => {

        const feature =
          layer.feature;


        if (!feature)
          return;


        const rawName =
          this.getOblastName(
            feature
          );


        if (!rawName)
          return;


        const name =
          this.displayOblastName(
            rawName
          );


        const center =
          this.getLayerCenter(
            layer
          );


        if (!center)
          return;


        const width =
          this.getOblastLabelWidth(
            layer
          );


        const marker =
          L.marker(
            center,
            {

              pane:
                "oblastLabels",

              interactive:false,

              keyboard:false,

              icon:
                L.divIcon({

                  className:
                    "oblast-label-wrapper",

                  html:`
                    <div
                      class="oblast-label"

                      style="
                        width:${Math.round(width)}px;
                      "
                    >
                      ${this.formatOblastLabel(
                        name
                      )}
                    </div>
                  `,

                  iconSize:[
                    width,
                    30
                  ],

                  iconAnchor:[
                    width / 2,
                    15
                  ]
                })
            }
          )
          .addTo(
            this._map
          );


        this._oblastLabels.push({

          marker,

          layer,

          name
        });
      }
    );
  }


  formatOblastLabel(name) {

    const escaped =
      this.escape(
        name
      );


    /*
     * Для назв з дефісом браузеру дозволяємо
     * перенесення саме після дефіса.
     */

    if (
      name.includes("-")
    ) {

      const parts =
        escaped.split("-");


      if (
        parts.length === 2
      ) {

        return `
          ${parts[0]}-<wbr>${parts[1]}
        `;
      }
    }


    return escaped;
  }


  findContainingOblast(lat, lon) {

    if (!this._oblastLayer)
      return null;

    const point =
      L.latLng(
        lat,
        lon
      );

    let found = null;

    this._oblastLayer.eachLayer(
      layer => {

        if (
          !found &&
          this.pointInFeature(
            point,
            layer.feature
          )
        ) {

          found = layer;
        }
      }
    );

    return found;
  }


  /* =========================================================
     REGIONAL CENTERS
     ========================================================= */

  getRegionalCenters() {

    return [

      {
        name:"Вінниця",
        lat:49.2331,
        lon:28.4682,
        priority:2
      },

      {
        name:"Луцьк",
        lat:50.7472,
        lon:25.3254,
        priority:2
      },

      {
        name:"Дніпро",
        lat:48.4647,
        lon:35.0462,
        priority:3
      },

      {
        name:"Донецьк",
        lat:48.0159,
        lon:37.8029,
        priority:2
      },

      {
        name:"Житомир",
        lat:50.2547,
        lon:28.6587,
        priority:2
      },

      {
        name:"Ужгород",
        lat:48.6208,
        lon:22.2879,
        priority:2
      },

      {
        name:"Запоріжжя",
        lat:47.8388,
        lon:35.1396,
        priority:3
      },

      {
        name:"Івано-Франківськ",
        lat:48.9226,
        lon:24.7111,
        priority:1
      },

      {
        name:"Київ",
        lat:50.4501,
        lon:30.5234,
        priority:4
      },

      {
        name:"Кропивницький",
        lat:48.5079,
        lon:32.2623,
        priority:1
      },

      {
        name:"Луганськ",
        lat:48.5740,
        lon:39.3078,
        priority:2
      },

      {
        name:"Львів",
        lat:49.8397,
        lon:24.0297,
        priority:3
      },

      {
        name:"Миколаїв",
        lat:46.9750,
        lon:31.9946,
        priority:3
      },

      {
        name:"Одеса",
        lat:46.4825,
        lon:30.7233,
        priority:4
      },

      {
        name:"Полтава",
        lat:49.5883,
        lon:34.5514,
        priority:2
      },

      {
        name:"Рівне",
        lat:50.6199,
        lon:26.2516,
        priority:2
      },

      {
        name:"Суми",
        lat:50.9077,
        lon:34.7981,
        priority:2
      },

      {
        name:"Тернопіль",
        lat:49.5535,
        lon:25.5948,
        priority:2
      },

      {
        name:"Харків",
        lat:49.9935,
        lon:36.2304,
        priority:4
      },

      {
        name:"Херсон",
        lat:46.6354,
        lon:32.6169,
        priority:3
      },

      {
        name:"Хмельницький",
        lat:49.4229,
        lon:26.9871,
        priority:1
      },

      {
        name:"Черкаси",
        lat:49.4444,
        lon:32.0598,
        priority:2
      },

      {
        name:"Чернівці",
        lat:48.2915,
        lon:25.9403,
        priority:2
      },

      {
        name:"Чернігів",
        lat:51.4982,
        lon:31.2893,
        priority:2
      },

      {
        name:"Сімферополь",
        lat:44.9521,
        lon:34.1024,
        priority:2
      }

    ];
  }


  createRegionalCenters() {

    if (
      !this.config.show_regional_centers
    )
      return;


    for (
      const item
      of this._cityLabels
    ) {

      try {

        item.marker.remove();

      }
      catch(e) {}
    }


    this._cityLabels = [];


    for (
      const city
      of this.getRegionalCenters()
    ) {

      const marker =
        L.marker(
          [
            city.lat,
            city.lon
          ],
          {

            pane:
              "cityLabels",

            interactive:false,

            keyboard:false,

            icon:
              L.divIcon({

                className:
                  "city-label-wrapper",

                html:`

                  <div
                    class="city-label"
                  >

                    <span
                      class="city-dot"
                    ></span>

                    <span
                      class="city-name"
                    >
                      ${this.escape(
                        city.name
                      )}
                    </span>

                  </div>
                `,

                /*
                 * Великий transparent box тут
                 * спеціально НЕ робимо.
                 *
                 * Реальна ширина визначається
                 * самим текстом.
                 */

                iconSize:[
                  4,
                  18
                ],

                iconAnchor:[
                  2,
                  9
                ]
              })
          }
        )
        .addTo(
          this._map
        );


      this._cityLabels.push({

        marker,

        city,

        layer:
          this.findContainingOblast(
            city.lat,
            city.lon
          )
      });
    }
  }


  /* =========================================================
     RAIONS / DISTRICTS
     ========================================================= */

  normalizeRaionName(name) {

    return String(
      name || ""
    )
      .toLowerCase()
      .replaceAll("’","'")
      .replaceAll("ʼ","'")
      .replace(/\s+район$/i,"")
      .trim();
  }


  getRaionName(feature) {

    const p =
      feature?.properties || {};


    return (
      p.rayon ||
      p.name_uk ||
      p["name:uk"] ||
      p.name ||
      p.admin2Name_ua ||
      ""
    );
  }


  getRaionAlertLevel(feature) {

    const featureName =
      this.normalizeRaionName(
        this.getRaionName(
          feature
        )
      );


    if (!featureName)
      return null;


    return (
      this._raionAlertLevels.get(
        featureName
      ) || null
    );
  }


  rebuildAlertIndexes() {

    const raions =
      new Map();


    for (
      const alert
      of (this._snapshot.alerts || [])
    ) {

      if (
        !alert ||
        typeof alert === "string"
      )
        continue;


      const name =
        this.normalizeRaionName(
          alert.name ||
          alert.raion ||
          alert.district ||
          ""
        );


      if (!name)
        continue;


      const level =
        String(
          alert.level || ""
        )
          .toLowerCase()
          .trim();


      const previous =
        raions.get(name);


      if (
        level === "red" ||
        (
          level === "yellow" &&
          previous !== "red"
        )
      )
        raions.set(
          name,
          level
        );
    }


    this._raionAlertLevels =
      raions;
  }


  raionStyle(feature) {

    const level =
      this.getRaionAlertLevel(
        feature
      );


    const palette =
      this.mapPalette();


    /*
     * Межі районів керуються updateRaionDisplay().
     * Тут важлива заливка: вона активна навіть на min zoom.
     */

    if (level === "red") {

      return {
        color:palette.redStroke,
        weight:0,
        opacity:0,
        fillColor:palette.redFill,
        fillOpacity:1
      };
    }


    if (level === "yellow") {

      return {
        color:palette.yellowStroke,
        weight:0,
        opacity:0,
        fillColor:palette.yellowFill,
        fillOpacity:1
      };
    }


    return {
      color:
        this.isLightTheme()
          ? "rgba(70,85,95,.55)"
          : "rgba(220,232,238,.55)",

      weight:0,
      opacity:0,
      fillOpacity:0
    };
  }


  applyRaionOblastClip() {

    if (
      !this._map ||
      !this._raionLayer ||
      !this._oblastLayer
    )
      return;


    const pane =
      this._map.getPane(
        "raions"
      );


    const svg =
      pane?.querySelector(
        "svg"
      );


    if (!svg)
      return;


    /*
     * Build district -> oblast ownership only once.
     *
     * The old implementation repeated getBounds(), pointInFeature()
     * and Array.find() for every district after every move/zoom.
     * That was particularly expensive in Safari/WKWebView.
     */
    if (!this._raionClipAssignments) {

      const oblasts = [];


      this._oblastLayer.eachLayer(
        layer => {

          if (
            !layer.feature ||
            !layer._path
          )
            return;


          const name =
            this.normalizeName(
              this.getOblastName(
                layer.feature
              )
            );


          if (!name)
            return;


          oblasts.push({
            feature:layer.feature,
            layer,
            id:
              "neptun-oblast-clip-" +
              name.replace(
                /[^a-zа-яіїєґ0-9]+/gi,
                "-"
              )
          });
        }
      );


      const assignments = [];


      this._raionLayer.eachLayer(
        district => {

          if (
            !district.feature ||
            !district._path
          )
            return;


          const center =
            district.getBounds()
              .getCenter();


          const oblast =
            oblasts.find(
              item =>
                this.pointInFeature(
                  center.lat,
                  center.lng,
                  item.feature
                )
            );


          if (oblast)
            assignments.push({
              district,
              oblast
            });
        }
      );


      this._raionClipAssignments =
        assignments;
    }


    /*
     * Keep one persistent <defs>. Recreating all clipPath nodes on
     * every moveend/zoomend caused avoidable SVG DOM churn.
     */
    let defs =
      this._raionClipDefs;


    if (
      !defs ||
      defs.ownerSVGElement !== svg
    ) {

      defs =
        svg.querySelector(
          "defs[data-neptun-clips]"
        );


      if (!defs) {

        defs =
          document.createElementNS(
            "http://www.w3.org/2000/svg",
            "defs"
          );

        defs.setAttribute(
          "data-neptun-clips",
          "1"
        );

        svg.insertBefore(
          defs,
          svg.firstChild
        );
      }


      this._raionClipDefs = defs;
      this._raionClipPaths.clear();
    }


    /*
     * Leaflet changes the oblast SVG path's "d" on zoom. Copy only
     * that geometry into our persistent clip paths. No node removal,
     * clone storm or district ownership calculation is needed.
     */
    for (
      const item
      of this._raionClipAssignments
    ) {

      const {
        district,
        oblast
      } = item;


      if (
        !district._path ||
        !oblast.layer._path
      )
        continue;


      let clipPath =
        this._raionClipPaths.get(
          oblast.id
        );


      if (!clipPath) {

        const clip =
          document.createElementNS(
            "http://www.w3.org/2000/svg",
            "clipPath"
          );

        clip.id =
          oblast.id;


        clipPath =
          document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path"
          );

        clipPath.setAttribute(
          "fill",
          "#000"
        );

        clipPath.setAttribute(
          "stroke",
          "none"
        );

        clip.appendChild(
          clipPath
        );

        defs.appendChild(
          clip
        );

        this._raionClipPaths.set(
          oblast.id,
          clipPath
        );
      }


      const d =
        oblast.layer._path
          .getAttribute(
            "d"
          );


      if (
        d &&
        clipPath.getAttribute("d") !== d
      )
        clipPath.setAttribute(
          "d",
          d
        );


      const expected =
        `url(#${oblast.id})`;


      if (
        district._path.getAttribute(
          "clip-path"
        ) !== expected
      )
        district._path.setAttribute(
          "clip-path",
          expected
        );
    }
  }

  buildInternalRaionBoundaries(geojson) {

    /*
     * Беремо тільки сегменти, які належать двом районним
     * полігонам. Сегмент, що зустрівся один раз, є зовнішнім
     * периметром і тут навмисно не малюється.
     */

    const segments =
      new Map();


    const addRing =
      ring => {

        for (
          let i = 1;
          i < ring.length;
          i++
        ) {

          const a = ring[i - 1];
          const b = ring[i];


          const ka =
            a[0].toFixed(6) +
            "," +
            a[1].toFixed(6);

          const kb =
            b[0].toFixed(6) +
            "," +
            b[1].toFixed(6);


          const key =
            ka < kb
              ? ka + "|" + kb
              : kb + "|" + ka;


          const found =
            segments.get(key);


          if (found)
            found.count++;

          else
            segments.set(
              key,
              {
                count:1,
                coords:[a,b]
              }
            );
        }
      };


    const addPolygon =
      polygon => {

        /*
         * GeoJSON Polygon: coordinates[0] — зовнішній контур,
         * coordinates[1..] — внутрішні отвори (водойми, острови
         * та інші вирізи). Для районної адміністративної сітки
         * вони не є межами районів і мають бути проігноровані.
         */

        const outerRing =
          polygon?.[0];


        if (
          outerRing &&
          outerRing.length > 1
        )
          addRing(
            outerRing
          );
      };


    for (
      const feature
      of geojson.features || []
    ) {

      const geometry =
        feature.geometry;


      if (!geometry)
        continue;


      if (
        geometry.type ===
        "Polygon"
      )
        addPolygon(
          geometry.coordinates
        );


      else if (
        geometry.type ===
        "MultiPolygon"
      ) {

        for (
          const polygon
          of geometry.coordinates
        )
          addPolygon(polygon);
      }
    }


    return {
      type:"Feature",

      properties:{},

      geometry:{
        type:"MultiLineString",

        coordinates:
          [...segments.values()]
            .filter(
              item =>
                item.count > 1
            )
            .map(
              item =>
                item.coords
            )
      }
    };
  }


  async loadRaions() {

    if (
      this._raionsLoaded ||
      !this._map
    )
      return;


    this._raionsLoaded = true;


    /*
     * Один легкий nationwide GeoJSON замість 25 важких
     * обласних файлів. Цю саму геометрію використовуємо і
     * для alert-fill, і для районних меж.
     *
     * Зовнішню похибку спрощеної геометрії вже прибирає
     * applyRaionOblastClip(), а еталонний контур областей
     * лишається окремим верхнім шаром.
     */

    const URL =
      "https://raw.githubusercontent.com/slawomirmatuszak/ukrainian_geodata/master/rayony.geojson";


    const cacheKey =
      "neptun_raions_fast_v1";


    let geojson = null;


    try {

      const cached =
        localStorage.getItem(
          cacheKey
        );


      if (cached)
        geojson =
          JSON.parse(cached);

    }
    catch(e) {}


    try {

      if (!geojson) {

        const response =
          await fetch(
            URL
          );


        if (!response.ok)
          throw new Error(
            "Raion GeoJSON HTTP " +
            response.status
          );


        geojson =
          await response.json();


        try {

          localStorage.setItem(
            cacheKey,
            JSON.stringify(
              geojson
            )
          );

        }
        catch(e) {}
      }


      this._raionLayer =
        L.geoJSON(
          geojson,
          {
            pane:"raions",

            interactive:false,

            style:
              feature =>
                this.raionStyle(
                  feature
                )
          }
        )
        .addTo(
          this._map
        );


      /*
       * Межі використовують той самий уже завантажений
       * GeoJSON — другого HTTP-запиту та другого JSON.parse
       * більше немає.
       */

      /*
       * Do NOT instantiate the nationwide district polygons twice.
       *
       * The fill layer above already owns all district polygons.
       * For visible district borders we only need shared internal
       * line segments, so build one lightweight MultiLineString.
       * This removes the second full set of Leaflet polygon paths
       * from the DOM and cuts projection work during zoom.
       */
      this._raionBoundaryGeoJSON =
        this.buildInternalRaionBoundaries(
          geojson
        );


      this._raionBoundaryLayer =
        L.geoJSON(
          this._raionBoundaryGeoJSON,
          {
            pane:"raions",
            interactive:false,

            style:() => ({
              weight:0,
              opacity:0,
              fill:false,
              fillOpacity:0
            })
          }
        )
        .addTo(
          this._map
        );


      this.loadRaionCenters();
      this.updateRaionDisplay();

      requestAnimationFrame(
        () =>
          this.applyRaionOblastClip()
      );

    }

    catch(e) {

      console.warn(
        "NEPTUN CARD: raions:",
        e
      );


      this._raionsLoaded = false;
    }
  }


  async loadRaionCenters() {

    if (!this._map)
      return;


    try {

      const URL =
        "https://gis.unocha.org/server/rest/services/Hosted/cod_ab_ukr_v05/FeatureServer/0/query?where=adm_p_lvl%3D2&outFields=*&returnGeometry=true&outSR=4326&f=geojson";


      const response =
        await fetch(URL);


      if (!response.ok)
        throw new Error(
          "Raion centers HTTP " +
          response.status
        );


      const data =
        await response.json();


      for (
        const feature
        of (
          data?.features || []
        )
      ) {

        const coordinates =
          feature?.geometry?.coordinates;


        if (
          !coordinates ||
          feature?.geometry?.type !==
          "Point"
        )
          continue;


        const p =
          feature.properties || {};


        /*
         * У різних версіях COD поля називаються по-різному.
         * p.name часто англомовний, тому не беремо його першим.
         * Спочатку шукаємо явні українські поля, а потім —
         * будь-яке текстове поле з кирилицею.
         */

        const ukrainianCandidates = [
          p.name_ua,
          p.name_uk,
          p["name:uk"],
          p.admin2Name_ua,
          p.admin2name_ua,
          p.ADM2_UA,
          p.adm2_ua,
          p.ADM2_NAME_UA,
          p.admin_center_ua,
          p.center_ua
        ];


        let name =
          ukrainianCandidates.find(
            value =>
              typeof value === "string" &&
              /[А-Яа-яІіЇїЄєҐґ]/.test(value)
          ) || "";


        if (!name) {

          name =
            Object.values(p).find(
              value =>
                typeof value === "string" &&
                /[А-Яа-яІіЇїЄєҐґ]/.test(value) &&
                !/область$/i.test(value)
            ) || "";
        }


        /*
         * Англійський fallback лишаємо тільки якщо джерело
         * взагалі не віддало української назви.
         */

        if (!name) {

          name =
            p.name ||
            p.admin2Name ||
            p.ADM2_EN ||
            "";
        }


        if (!name)
          continue;


        const marker =
          L.marker(
            [
              coordinates[1],
              coordinates[0]
            ],
            {
              pane:"raionLabels",
              interactive:false,
              keyboard:false,

              icon:
                L.divIcon({
                  className:
                    "raion-center-wrapper",

                  html:`
                    <div class="raion-center-label">
                      <span class="raion-center-dot"></span>
                      <span class="raion-center-name">
                        ${this.escape(name)}
                      </span>
                    </div>
                  `,

                  iconSize:[4,18],
                  iconAnchor:[2,9]
                })
            }
          )
          .addTo(
            this._map
          );


        this._raionCenterLabels.push({
          marker,
          name
        });
      }


      this.updateRaionDisplay();

    }

    catch(e) {

      console.warn(
        "NEPTUN CARD: raion centers:",
        e
      );
    }
  }


  refreshRaions() {

    /*
     * updateRaionDisplay() already applies the complete fill and
     * boundary style. A separate full setStyle() pass here used to
     * style every district twice for each realtime snapshot.
     */

    this.updateRaionDisplay();
  }


  updateRaionDisplay() {

    if (!this._map)
      return;


    const delta =
      this._map.getZoom() -
      this._minimumZoom;


    const showBoundary =
      delta >= 1.55;


    const showCenters =
      delta >= 2.0;


    if (this._raionLayer) {

      const light =
        this.isLightTheme();


      this._raionLayer.eachLayer(
        layer => {

          const level =
            this.getRaionAlertLevel(
              layer.feature
            );


          const base =
            this.raionStyle(
              layer.feature
            );


          layer.setStyle({
            ...base,
            weight:0,
            opacity:0
          });
        }
      );
    }


    if (this._raionBoundaryLayer) {

      /*
       * Boundary geometry is now a single internal-line layer,
       * not a second copy of every district polygon. Style it once.
       */
      this._raionBoundaryLayer.setStyle({
        color:
          this.isLightTheme()
            ? "rgba(74,88,98,.42)"
            : "rgba(176,191,199,.34)",

        weight:
          showBoundary
            ? (
                delta >= 3.5
                  ? .72
                  : .62
              )
            : 0,

        opacity:
          showBoundary
            ? .9
            : 0,

        fill:false,
        fillOpacity:0
      });
    }


    for (
      const item
      of this._raionCenterLabels
    ) {

      const el =
        item.marker.getElement();


      if (!el)
        continue;


      el.style.display =
        showCenters
          ? ""
          : "none";


      if (!showCenters)
        continue;


      const root =
        el.querySelector(
          ".raion-center-label"
        );


      if (!root)
        continue;


      /*
       * Районні центри з'являються лише після zoom +2.
       * Далі плавно збільшуємо підпис разом із наближенням,
       * щоб на великому zoom він не залишався мікроскопічним.
       */

      const raionFont =
        delta < 2.5
          ? 8.2
          : (
              delta < 3.5
                ? 9.2
                : (
                    delta < 4.5
                      ? 10.2
                      : 11.2
                  )
            );


      root.style.fontSize =
        `${raionFont}px`;


      if (this.isLightTheme()) {

        root.style.color =
          "#111820";

        root.style.textShadow =
          "-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 0 3px #fff";

      }

      else {

        root.style.color =
          "#fff";

        root.style.textShadow =
          "-1px -1px 0 rgba(0,0,0,.8), 1px -1px 0 rgba(0,0,0,.8), -1px 1px 0 rgba(0,0,0,.8), 1px 1px 0 rgba(0,0,0,.8), 0 0 3px #000";
      }
    }
  }


  /* =========================================================
     KYIV CITY BOUNDARY
     ========================================================= */

  async loadKyivBoundary() {

    if (
      this._kyivBoundaryLoaded ||
      !this._map
    )
      return;

    this._kyivBoundaryLoaded = true;

    try {

      const url =
        "https://nominatim.openstreetmap.org/search?city=Kyiv&country=Ukraine&format=geojson&polygon_geojson=1&limit=1&accept-language=uk";

      const response =
        await fetch(
          url,
          {
            headers:{
              "Accept":"application/geo+json,application/json"
            }
          }
        );

      if (!response.ok)
        throw new Error(
          "Kyiv boundary HTTP " +
          response.status
        );

      const data =
        await response.json();

      const feature =
        data?.features?.find(
          item =>
            item?.geometry &&
            (
              item.geometry.type ===
              "Polygon" ||
              item.geometry.type ===
              "MultiPolygon"
            )
        );

      if (!feature)
        throw new Error(
          "Kyiv boundary geometry not found"
        );

      this._kyivBoundary =
        L.geoJSON(
          feature,
          {
            pane:
              "kyivBoundary",

            interactive:false,

            style:{
              color:
                "rgba(220,232,238,.78)",

              weight:1,

              opacity:0,

              fill:false,

              dashArray:
                "4 3"
            }
          }
        )
        .addTo(
          this._map
        );

      this.updateKyivBoundary();

    }

    catch(e) {

      console.warn(
        "NEPTUN CARD: Kyiv boundary:",
        e
      );

      this._kyivBoundaryLoaded = false;
    }
  }


  getKyivAlertLevel() {

    let level = null;

    const isKyivCity =
      value => {

        const name =
          String(value || "")
            .toLowerCase()
            .replaceAll("’", "'")
            .replaceAll("ʼ", "'")
            .replace(/^м(?:істо)?\.?\s*/i, "")
            .replace(/\s+(?:міська\s+)?територіальна\s+громада$/i, "")
            .trim();

        return (
          name === "київ" ||
          name === "kyiv" ||
          name === "kiev"
        );
      };


    for (
      const alert
      of (this._snapshot.alerts || [])
    ) {

      if (
        !alert ||
        typeof alert === "string"
      )
        continue;

      const name =
        alert.name ||
        alert.raion ||
        alert.district ||
        alert.city ||
        alert.community ||
        "";

      if (!isKyivCity(name))
        continue;

      const alertLevel =
        String(alert.level || "")
          .toLowerCase()
          .trim();

      if (alertLevel === "red")
        return "red";

      if (alertLevel === "yellow")
        level = "yellow";
    }


    for (
      const alert
      of (this._snapshot.alertOblasts || [])
    ) {

      const name =
        typeof alert === "string"
          ? alert
          : (
              alert.city ||
              alert.oblast ||
              alert.region ||
              alert.name ||
              ""
            );

      if (!isKyivCity(name))
        continue;

      const alertLevel =
        String(alert?.level || "")
          .toLowerCase()
          .trim();

      if (alertLevel === "red")
        return "red";

      if (alertLevel === "yellow")
        level = "yellow";
      else if (!level)
        level = "red";
    }


    return level;
  }


  updateKyivBoundary() {

    if (
      !this._map ||
      !this._kyivBoundary
    )
      return;

    const delta =
      this._map.getZoom() -
      this._minimumZoom;

    let opacity = 0;
    let weight = 1;
    let dashArray = "4 3";

    if (
      delta >= 1.25 &&
      delta < 2
    ) {

      opacity = .58;
    }

    else if (
      delta >= 2 &&
      delta < 3
    ) {

      opacity = .74;
      weight = 1.25;
    }

    else if (
      delta >= 3
    ) {

      opacity = .88;
      weight = 1.5;
      dashArray = null;
    }

    const level =
      this.getKyivAlertLevel();

    const palette =
      this.mapPalette();

    let fillColor;
    let fillOpacity = 0;

    if (level === "red") {
      fillColor = palette.redFill;
      fillOpacity = 1;
    }

    else if (level === "yellow") {
      fillColor = palette.yellowFill;
      fillOpacity = 1;
    }

    this._kyivBoundary.setStyle({
      color:
        level === "red"
          ? palette.redStroke
          : level === "yellow"
            ? palette.yellowStroke
            : "rgba(220,232,238,.78)",
      opacity,
      weight,
      dashArray,
      fill:!!level,
      fillColor,
      fillOpacity
    });
  }


  /* =========================================================
     LABEL ZOOM + COLLISION DETECTION
     ========================================================= */

  applyMapLabelTheme() {

    const light =
      this.isLightTheme();


    for (
      const item
      of this._oblastLabels
    ) {

      const el =
        item.marker
          .getElement()
          ?.querySelector(
            ".oblast-label"
          );


      if (!el)
        continue;


      el.classList.toggle(
        "label-light",
        light
      );


      el.classList.toggle(
        "label-dark",
        !light
      );
    }


    for (
      const item
      of this._cityLabels
    ) {

      const root =
        item.marker
          .getElement()
          ?.querySelector(
            ".city-label"
          );


      if (!root)
        continue;


      root.classList.toggle(
        "label-light",
        light
      );


      root.classList.toggle(
        "label-dark",
        !light
      );
    }
  }


  updateMapLabels() {

    if (!this._map)
      return;


    this.applyMapLabelTheme();


    /*
     * Не покладаємося на CSS selector/class для кольорів.
     * Leaflet divIcon живе у власному DOM-шарі, тому тему
     * задаємо inline безпосередньо елементам label.
     */

    const lightTheme =
      this.isLightTheme();


    const zoom =
      this._map.getZoom();


    const min =
      Number.isFinite(
        this._minimumZoom
      )
        ? this._minimumZoom
        : zoom;


    const delta =
      Math.max(
        0,
        zoom - min
      );


    /*
     * ---------------------------------------------------------
     * РОЗМІРИ НАЗВ ОБЛАСТЕЙ
     * ---------------------------------------------------------
     */

    let oblastFont;
    let oblastOpacity;


    if (delta < .75) {

      oblastFont = 6.8;
      oblastOpacity = .68;

    }

    else if (delta < 1.5) {

      oblastFont = 7.7;
      oblastOpacity = .76;

    }

    else if (delta < 2.5) {

      oblastFont = 9.2;
      oblastOpacity = .84;

    }

    else if (delta < 3.5) {

      oblastFont = 10.4;
      oblastOpacity = .88;

    }

    else if (delta < 4.5) {

      oblastFont = 11.4;
      oblastOpacity = .9;

    }

    else {

      oblastFont = 12.4;
      oblastOpacity = .92;
    }


    /*
     * ---------------------------------------------------------
     * РОЗМІРИ НАЗВ МІСТ
     * ---------------------------------------------------------
     */

    let cityFont;
    let cityOpacity;


    if (delta < .75) {

      cityFont = 6.2;
      cityOpacity = .72;

    }

    else if (delta < 1.5) {

      cityFont = 7;
      cityOpacity = .78;

    }

    else if (delta < 2.5) {

      cityFont = 8;
      cityOpacity = .86;

    }

    else {

      cityFont = 9;
      cityOpacity = .92;
    }


    /*
     * Спочатку оновлюємо CSS усіх
     * назв областей.
     */

    for (
      const item
      of this._oblastLabels
    ) {

      const el =
        item.marker
          .getElement()
          ?.querySelector(
            ".oblast-label"
          );


      if (!el)
        continue;


      const baseWidth =
        this.getOblastLabelWidth(
          item.layer
        );


      /*
       * Після збільшення шрифту у light theme старий width
       * став затісним і обрізав/переносив назви. Даємо напису
       * трохи більше місця, але без агресивного розтягування.
       */

      /*
       * У light theme лишаємо чорний текст + білий halo,
       * але геометрію повертаємо майже до штатної.
       * На загальному вигляді це не дає назвам областей
       * забивати одна одну.
       */

      const width =
        lightTheme
          ? Math.min(
              130,
              baseWidth * 1.06
            )
          : baseWidth;


      el.style.width =
        `${Math.round(width)}px`;


      const labelFont =
        lightTheme
          ? oblastFont * 1.06
          : oblastFont;


      el.style.fontSize =
        `${labelFont}px`;


      el.style.opacity =
        String(
          lightTheme
            ? Math.max(.92, oblastOpacity)
            : oblastOpacity
        );


      if (lightTheme) {

        el.style.setProperty(
          "color",
          "#111820",
          "important"
        );

        el.style.setProperty(
          "font-weight",
          "800",
          "important"
        );

        el.style.setProperty(
          "background",
          "transparent",
          "important"
        );

        el.style.setProperty(
          "text-shadow",
          "-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 0 3px #fff",
          "important"
        );

      }

      else {

        el.style.removeProperty(
          "color"
        );

        el.style.removeProperty(
          "font-weight"
        );

        el.style.removeProperty(
          "background"
        );

        el.style.removeProperty(
          "text-shadow"
        );
      }
    }


    /*
     * Оновлюємо CSS міст.
     *
     * Усі назви спочатку показуємо,
     * потім collision detector сховає
     * ті, що заважають.
     */

    for (
      const item
      of this._cityLabels
    ) {

      const root =
        item.marker
          .getElement()
          ?.querySelector(
            ".city-label"
          );


      const name =
        item.marker
          .getElement()
          ?.querySelector(
            ".city-name"
          );


      const dot =
        item.marker
          .getElement()
          ?.querySelector(
            ".city-dot"
          );


      if (!root)
        continue;


      /*
       * На загальному вигляді України показуємо тільки
       * назви областей. Обласні центри починають проявлятися
       * після першого помітного наближення.
       */

      const showRegionalCenter =
        delta >= 1.0;


      root.style.display =
        showRegionalCenter
          ? ""
          : "none";


      if (!showRegionalCenter)
        continue;


      /*
       * Усі населені пункти використовують одну шкалу:
       * районні та обласні центри мають однаковий font-size.
       */

      const regionalFont =
        delta < .75
          ? cityFont
          : (
              delta < 1.5
                ? cityFont
                : (
                    delta < 2.0
                      ? cityFont
                      : (
                          delta < 2.5
                            ? 8.2
                            : (
                                delta < 3.5
                                  ? 9.2
                                  : (
                                      delta < 4.5
                                        ? 10.2
                                        : 11.2
                                    )
                              )
                        )
                  )
            );


      const labelFont =
        lightTheme
          ? regionalFont * 1.06
          : regionalFont;


      root.style.fontSize =
        `${labelFont}px`;


      root.style.opacity =
        String(
          lightTheme
            ? Math.max(.94, cityOpacity)
            : cityOpacity
        );


      if (lightTheme) {

        root.style.setProperty(
          "color",
          "#111820",
          "important"
        );

        root.style.setProperty(
          "font-weight",
          "800",
          "important"
        );

        root.style.setProperty(
          "text-shadow",
          "-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 0 3px #fff",
          "important"
        );

        if (name)
          name.style.setProperty(
            "background",
            "transparent",
            "important"
          );

        if (dot) {

          dot.style.setProperty(
            "background",
            "#111820",
            "important"
          );

          dot.style.setProperty(
            "box-shadow",
            "0 0 0 1px #fff, 0 0 3px #fff",
            "important"
          );
        }

      }

      else {

        root.style.removeProperty(
          "color"
        );

        root.style.removeProperty(
          "font-weight"
        );

        root.style.removeProperty(
          "text-shadow"
        );

        if (name)
          name.style.removeProperty(
            "background"
          );

        if (dot) {

          dot.style.removeProperty(
            "background"
          );

          dot.style.removeProperty(
            "box-shadow"
          );
        }
      }


      if (name) {

        name.classList.remove(
          "label-hidden"
        );
      }


      /*
       * Точка міста залишається завжди.
       */

      if (dot) {

        const dotSize =
          delta < .75
            ? 2.5
            : (
                delta < 1.5
                  ? 3
                  : 3.5
              );


        dot.style.width =
          `${dotSize}px`;


        dot.style.height =
          `${dotSize}px`;
      }
    }


    /*
     * DOM після зміни font-size має
     * перемірятися перед collision detection.
     */

    requestAnimationFrame(
      () => {

        this.resolveLabelCollisions(
          delta
        );
      }
    );
  }


  resolveLabelCollisions(delta) {

    if (!this._map)
      return;


    const occupied = [];


    /*
     * ---------------------------------------------------------
     * 1. НАЗВИ ОБЛАСТЕЙ МАЮТЬ ПЕРШИЙ ПРІОРИТЕТ
     * ---------------------------------------------------------
     *
     * Вони формують базову географічну сітку.
     */

    for (
      const item
      of this._oblastLabels
    ) {

      const el =
        item.marker
          .getElement()
          ?.querySelector(
            ".oblast-label"
          );


      if (!el)
        continue;


      const rect =
        this.getElementRect(
          el
        );


      if (!rect)
        continue;


      occupied.push(
        this.padRect(
          rect,
          delta < 1
            ? 1
            : 2
        )
      );
    }


    /*
     * ---------------------------------------------------------
     * 2. СОРТУЄМО МІСТА ЗА ПРІОРИТЕТОМ
     * ---------------------------------------------------------
     *
     * Київ / Одеса / Харків тощо отримують
     * шанс залишитися першими.
     */

    const cities =
      [...this._cityLabels]
        .sort(
          (a,b) =>
            (
              b.city.priority || 0
            ) -
            (
              a.city.priority || 0
            )
        );


    for (
      const item
      of cities
    ) {

      const markerElement =
        item.marker
          .getElement();


      if (!markerElement)
        continue;


      const root =
        markerElement.querySelector(
          ".city-label"
        );


      const name =
        markerElement.querySelector(
          ".city-name"
        );


      if (
        !root ||
        !name
      )
        continue;


      /*
       * На сильному zoom назви вже можна
       * показувати практично всі.
       */

      if (
        delta >= 2.0 &&
        (
          item.city.priority || 0
        ) >= 3
      ) {

        /*
         * Київ та найбільші обласні центри не повинні
         * зникати за написом області/району після наближення.
         */

        name.classList.remove(
          "label-hidden"
        );

        continue;
      }


      if (
        delta >= 2.5
      ) {

        name.classList.remove(
          "label-hidden"
        );

        continue;
      }


      /*
       * На мінімальному zoom дуже довгі
       * назви мають менший пріоритет.
       *
       * Точка міста при цьому НЕ зникає.
       */

      if (
        delta < .75 &&
        item.city.name.length > 12 &&
        (
          item.city.priority || 0
        ) < 3
      ) {

        name.classList.add(
          "label-hidden"
        );

        continue;
      }


      const rect =
        this.getElementRect(
          root
        );


      if (!rect)
        continue;


      const padded =
        this.padRect(
          rect,
          delta < .75
            ? 2.5
            : 2
        );


      if (
        this.rectIntersectsAny(
          padded,
          occupied
        )
      ) {

        /*
         * Назву ховаємо.
         * Точка міста залишається.
         */

        name.classList.add(
          "label-hidden"
        );

        continue;
      }


      /*
       * Якщо колізії нема —
       * резервуємо місце.
       */

      name.classList.remove(
        "label-hidden"
      );


      occupied.push(
        padded
      );
    }
  }


  /* =========================================================
     NEPTUN SDK
     ========================================================= */

  async loadSDK() {

    if (window.NEPTUN)
      return;


    await new Promise(
      (resolve,reject) => {

        const script =
          document.createElement(
            "script"
          );


        script.src =
          "https://neptun.in.ua/sdk/neptun.js";


        script.onload =
          resolve;


        script.onerror =
          () => reject(
            new Error(
              "NEPTUN SDK"
            )
          );


        document.head.appendChild(
          script
        );
      }
    );


    if (!window.NEPTUN) {

      throw new Error(
        "SDK не завантажено"
      );
    }
  }


  connectNeptun() {

    this._client =
      new window.NEPTUN
        .RealtimeClient(
          "https://neptun.in.ua"
        );


    this._unsubscribe =
      this._client.subscribe(
        snapshot => {

          if (!snapshot)
            return;


          this._snapshot =
            snapshot;


          /*
           * Build alert lookup tables once. District style functions
           * are called many times by Leaflet and must stay O(1).
           */
          this.rebuildAlertIndexes();


          /*
           * Залишаємо snapshot глобально
           * доступним для діагностики через
           * browser console.
           */

          window.neptunSnapshot =
            snapshot;


          this.renderThreats();

          this.refreshOblasts();
          this.refreshRaions();
          this.updateKyivBoundary();


          if (
            this._selectedThreat
          ) {

            const updated =
              (
                snapshot.threats ||
                []
              ).find(
                t =>
                  t.id ===
                  this._selectedThreat.id
              );


            if (updated) {

              this._selectedThreat =
                updated;


              this.renderInfo(
                updated
              );

            }

            else {

              this.closeInfo();
            }
          }


          if (
            this.config.show_status
          ) {

            this.status(
              `NEPTUN: online · ${
                (
                  snapshot.threats ||
                  []
                ).length
              } цілей`
            );

          }

          else {

            this.hideStatus();
          }
        }
      );


    this._client.start();

    this.startAnimation();
  }


  /* =========================================================
     MODEL DETECTION
     ========================================================= */

  getThreatModel(t) {

    const type =
      String(
        t?.type || ""
      )
        .toLowerCase()
        .trim();


    const text = [
      t?.title,
      t?.model,
      t?.name,
      t?.description,
      t?.explanationShort
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();


    /*
     * FPV
     */

    if (
      type === "fpv"
    )
      return "fpv";


    /*
     * Реактивний Shahed.
     *
     * Перевіряємо ДО звичайного UAV,
     * щоб Shahed-238 не перетворився
     * на звичайний Shahed.
     */

    if (
      type === "jet_uav" ||
      type === "jet-uav" ||
      type === "shahed_jet" ||
      type === "shahed-238"
    )
      return "shahed_jet";


    if (
      text.includes("shahed-238") ||
      text.includes("shahed 238") ||
      text.includes("шахед-238") ||
      text.includes("шахед 238") ||
      text.includes("реактивний шахед") ||
      text.includes("реактивний бпла")
    )
      return "shahed_jet";


    /*
     * Звичайний ударний БпЛА / Shahed.
     */

    if (
      type === "uav"
    )
      return "shahed";


    /*
     * Ракети.
     */

    if (
      type === "missile"
    )
      return "missile";


    if (
      type === "ballistic"
    )
      return "ballistic";


    /*
     * КАБ.
     */

    if (
      type === "kab" ||
      type === "bomb"
    )
      return "kab";


    /*
     * Розвідувальний БпЛА.
     */

    if (
      type === "recon"
    )
      return "recon";


    /*
     * МіГ-31К.
     */

    if (
      type === "mig31k" ||
      type === "mig-31k"
    )
      return "mig31k";


    /*
     * Інша авіація.
     */

    if (
      type === "aircraft" ||
      type === "plane"
    )
      return "aircraft";


    /*
     * Fallback по тексту.
     */

    if (
      text.includes("fpv")
    )
      return "fpv";


    if (
      text.includes("баліст")
    )
      return "ballistic";


    if (
      text.includes("каб") ||
      text.includes("авіабомб")
    )
      return "kab";


    if (
      text.includes("міг-31") ||
      text.includes("mig-31")
    )
      return "mig31k";


    if (
      text.includes("ракета")
    )
      return "missile";


    if (
      text.includes("розвід")
    )
      return "recon";


    if (
      text.includes("бпла") ||
      text.includes("дрон") ||
      text.includes("shahed") ||
      text.includes("шахед") ||
      text.includes("geran") ||
      text.includes("герань")
    )
      return "shahed";


    return "unknown";
  }


  /* =========================================================
     SVG MODELS
     ========================================================= */

  getThreatSVG(model) {

    const icons = {


      /*
       * -------------------------------------------------------
       * FPV
       * -------------------------------------------------------
       */

      fpv: `

        <svg viewBox="0 0 100 100">

          <path d="
            M45 44 L24 23
            L30 17 L50 38
            L70 17 L76 23
            L55 44 L76 65
            L70 71 L50 50
            L30 71 L24 65 Z
          "/>

          <path d="
            M40 35
            L60 35
            L66 50
            L60 65
            L40 65
            L34 50
            Z
          "/>

          <path d="
            M44 35
            L50 25
            L56 35
            Z
          "/>

          <circle
            cx="20"
            cy="19"
            r="7"
          />

          <circle
            cx="80"
            cy="19"
            r="7"
          />

          <circle
            cx="20"
            cy="75"
            r="7"
          />

          <circle
            cx="80"
            cy="75"
            r="7"
          />

        </svg>
      `,


      /*
       * -------------------------------------------------------
       * SHAHED / GERAN
       *
       * Дельтоподібне крило +
       * задній поршневий двигун/пропелер.
       * -------------------------------------------------------
       */

      shahed: `

        <svg viewBox="0 0 100 100">

          <path d="
            M47 2

            Q50 -1 53 2

            L56 27

            Q57 31 62 35

            L96 66

            Q99 69 99 74

            L99 82

            L64 82

            L58 75

            L55 75

            L55 88

            L52 91

            L48 91

            L45 88

            L45 75

            L42 75

            L36 82

            L1 82

            L1 74

            Q1 69 4 66

            L38 35

            Q43 31 44 27

            Z
          "/>


          <!-- задня вісь -->

          <rect
            x="48"
            y="89"
            width="4"
            height="6"
            rx="1"
          />


          <!-- пропелер -->

          <path d="
            M50 94

            C44 90
            35 90
            27 94

            C35 98
            44 98
            50 95

            C56 98
            65 98
            73 94

            C65 90
            56 90
            50 94

            Z
          "/>

        </svg>
      `,


      /*
       * -------------------------------------------------------
       * РЕАКТИВНИЙ SHAHED
       *
       * Та сама загальна геометрія,
       * але без пропелера.
       *
       * Ззаду виразне сопло.
       * -------------------------------------------------------
       */

      shahed_jet: `

        <svg viewBox="0 0 100 100">

          <path d="
            M47 2

            Q50 -1 53 2

            L56 27

            Q57 31 62 35

            L96 66

            Q99 69 99 74

            L99 82

            L64 82

            L58 75

            L57 75

            L57 87

            L43 87

            L43 75

            L42 75

            L36 82

            L1 82

            L1 74

            Q1 69 4 66

            L38 35

            Q43 31 44 27

            Z
          "/>


          <!-- реактивне сопло -->

          <path d="
            M43 84

            L57 84

            L60 94

            Q60 98 56 99

            L44 99

            Q40 98 40 94

            Z
          "/>


          <!-- внутрішня частина сопла -->

          <path
            d="
              M46 88
              L54 88
              L56 96
              L44 96
              Z
            "

            style="
              fill:rgba(0,0,0,.48);
              stroke:none;
            "
          />

        </svg>
      `,


      /*
       * -------------------------------------------------------
       * РОЗВІДУВАЛЬНИЙ БПЛА
       *
       * Довгі прямі крила.
       * -------------------------------------------------------
       */

      recon: `

        <svg viewBox="0 0 100 100">

          <path d="
            M47 1

            Q50 0 53 1

            L54 36

            L97 43

            Q100 44 100 48

            L100 53

            L55 52

            L55 77

            L68 87

            L66 92

            L53 87

            L52 99

            L48 99

            L47 87

            L34 92

            L32 87

            L45 77

            L45 52

            L0 53

            L0 48

            Q0 44 3 43

            L46 36

            Z
          "/>


          <circle
            cx="50"
            cy="25"
            r="3"

            style="
              fill:rgba(0,0,0,.32);
              stroke:none;
            "
          />

        </svg>
      `,


      /*
       * -------------------------------------------------------
       * КРИЛАТА РАКЕТА
       * -------------------------------------------------------
       */

      missile: `

        <svg viewBox="0 0 100 100">

          <!--
            Крилата ракета: довгий вузький фюзеляж,
            маленькі стрілоподібні крила та хвостове оперення.
            Свідомо не робимо великих "літакових" крил.
          -->

          <path d="
            M50 0

            Q55 7 56 17

            L55 53

            L72 66

            L70 72

            L55 67

            L54 84

            L63 94

            L59 97

            L52 91

            L51 100

            L49 100

            L48 91

            L41 97

            L37 94

            L46 84

            L45 67

            L30 72

            L28 66

            L45 53

            L44 17

            Q45 7 50 0

            Z
          "/>


          <path
            d="
              M47 15
              L53 15
              L53 79
              L47 79
              Z
            "

            style="
              fill:rgba(255,255,255,.10);
              stroke:none;
            "
          />

        </svg>
      `,


      /*
       * -------------------------------------------------------
       * БАЛІСТИКА
       *
       * Вузький корпус без великих крил.
       * -------------------------------------------------------
       */

      ballistic: `

        <svg viewBox="0 0 100 100">

          <path d="
            M50 0

            Q58 10 59 24

            L57 75

            L72 91

            L59 87

            L54 100

            L50 91

            L46 100

            L41 87

            L28 91

            L43 75

            L41 24

            Q42 10 50 0

            Z
          "/>


          <path
            d="
              M46 19
              L54 19
              L55 67
              L45 67
              Z
            "

            style="
              fill:rgba(255,255,255,.08);
              stroke:none;
            "
          />

        </svg>
      `,


      /*
       * -------------------------------------------------------
       * КАБ
       *
       * Бомба з крилами корекції.
       * -------------------------------------------------------
       */

      kab: `

        <svg viewBox="0 0 100 100">

          <!--
            КАБ у стилі офіційної карти NEPTUN:
            компактна авіабомба з хвостовим оперенням.
            Силует орієнтований носом униз; makeThreatIcon()
            далі повертає його відповідно до heading.
          -->

          <g transform="rotate(-32 50 50)">

            <!-- корпус бомби -->
            <path d="
              M50 16
              C57 18 62 25 63 34
              L65 67
              C65 77 59 87 50 94
              C41 87 35 77 35 67
              L37 34
              C38 25 43 18 50 16
              Z
            "/>

            <!-- ліве хвостове перо -->
            <path d="
              M39 34
              L21 22
              L25 15
              L43 26
              Z
            "/>

            <!-- праве хвостове перо -->
            <path d="
              M61 34
              L79 22
              L75 15
              L57 26
              Z
            "/>

            <!-- верхнє хвостове перо -->
            <path d="
              M46 27
              L47 7
              L53 7
              L54 27
              Z
            "/>

            <!-- невелика грань корпусу -->
            <path
              d="
                M42 37
                C46 34 54 34 58 37
                L59 65
                C59 73 55 81 50 86
                C47 82 44 76 43 69
                Z
              "
              style="
                fill:rgba(255,255,255,.12);
                stroke:none;
              "
            />

          </g>

        </svg>
      `,


      /*
       * -------------------------------------------------------
       * МіГ-31К
       *
       * Ширші крила, характерний
       * винищувальний силует.
       * -------------------------------------------------------
       */

      mig31k: `

        <svg viewBox="0 0 100 100">

          <path d="
            M47 0

            Q50 -1 53 0

            L56 27

            L62 39

            L96 59

            L94 68

            L61 59

            L58 75

            L75 90

            L72 96

            L56 88

            L54 100

            L50 94

            L46 100

            L44 88

            L28 96

            L25 90

            L42 75

            L39 59

            L6 68

            L4 59

            L38 39

            L44 27

            Z
          "/>


          <!-- два двигуни -->

          <path
            d="
              M44 82
              L49 82
              L48 96
              L42 96
              Z
            "
          />

          <path
            d="
              M51 82
              L56 82
              L58 96
              L52 96
              Z
            "
          />

        </svg>
      `,


      /*
       * -------------------------------------------------------
       * ЗВИЧАЙНА АВІАЦІЯ
       * -------------------------------------------------------
       */

      aircraft: `

        <svg viewBox="0 0 100 100">

          <path d="
            M47 1

            Q50 -1 53 1

            L56 35

            L94 55

            L92 63

            L57 55

            L55 78

            L70 90

            L68 96

            L53 89

            L52 100

            L48 100

            L47 89

            L32 96

            L30 90

            L45 78

            L43 55

            L8 63

            L6 55

            L44 35

            Z
          "/>

        </svg>
      `,


      /*
       * -------------------------------------------------------
       * НЕВІДОМА ЦІЛЬ
       *
       * Навмисно НЕ літак.
       *
       * Так ми не отримуємо ситуацію,
       * коли будь-який невідомий тип
       * раптом виглядає як авіація.
       * -------------------------------------------------------
       */

      unknown: `

        <svg viewBox="0 0 100 100">

          <path d="
            M50 6

            L61 36

            L94 50

            L61 64

            L50 94

            L39 64

            L6 50

            L39 36

            Z
          "/>


          <circle
            cx="50"
            cy="50"
            r="8"

            style="
              fill:rgba(0,0,0,.32);
              stroke:none;
            "
          />

        </svg>
      `
    };


    return (
      icons[model] ||
      icons.unknown
    );
  }


  /* =========================================================
     ICON SIZE
     ========================================================= */

  getBaseIconSize(model) {

    const sizes = {

      fpv:50,

      shahed:50,

      shahed_jet:50,

      recon:50,

      missile:50,

      ballistic:50,

      kab:50,

      mig31k:50,

      aircraft:50,

      unknown:50
    };


    return (
      sizes[model] ||
      50
    );
  }


  getZoomScale() {

    /*
     * Test mapping: every target uses the same 0.5 scale
     * at every zoom level.
     */

    return 0.5;
  }


  getZoomBucket() {

    const scale =
      this.getZoomScale();


    if (scale <= .5)
      return 0;


    if (scale <= .7)
      return 1;


    if (scale < 1)
      return 2;


    return 3;
  }


  /* =========================================================
     THREAT ICON
     ========================================================= */

  makeThreatIcon(t) {

    let meta = null;


    try {

      meta =
        window.NEPTUN
          .getTypeMeta(
            t.type
          );

    }

    catch(e) {}


    const model =
      this.getThreatModel(
        t
      );


    const symbol =
      this.getThreatSVG(
        model
      );


    const color =
      meta?.color ||
      this.typeColor(
        t.type,
        model
      );


    const baseSize =
      this.getBaseIconSize(
        model
      );


    const scale =
      this.getZoomScale();


    const visualSize =
      Math.max(
        14,
        Math.round(
          baseSize *
          scale
        )
      );


    /*
     * Hitbox не зменшуємо разом з іконкою.
     *
     * На смартфоні маленька іконка
     * все одно повинна нормально натискатися.
     */

    const hitboxSize = 50;


    /*
     * Area-only загрози не мають
     * точної координати.
     */

    if (t.areaOnly) {

      const areaScale =
        Math.max(
          .72,
          scale
        );


      return L.divIcon({

        className:"",

        html:`

          <div
            class="area-threat"

            style="
              border-left:
                3px solid ${color};

              transform:
                scale(${areaScale});

              transform-origin:
                center center;
            "
          >

            ${this.escape(
              t.title ||
              this.typeName(
                t.type
              )
            )}

            ${
              Number(t.count) > 1
                ? ` ×${t.count}`
                : ""
            }

          </div>
        `,

        /*
         * Не задаємо вузький iconSize: текст "— по області"
         * може бути ширшим за 100px і Leaflet обрізав/зсував
         * вміст відносно темної плашки.
         */

        iconSize:null,

        iconAnchor:[
          0,
          13
        ]
      });
    }


    /*
     * Орієнтуємо силует по курсу.
     */

    const heading =
      Number(
        t.heading
      );


    const rotation =
      Number.isFinite(
        heading
      )
        ? `rotate(${heading}deg)`
        : "none";


    /*
     * Якщо в одній мітці декілька цілей —
     * показуємо компактний badge.
     */

    /*
     * Badge показує ТІЛЬКИ наш візуальний кластер.
     *
     * threat.count у NEPTUN означає оцінену кількість цілей
     * у одному повідомленні (наприклад count:4), але сам
     * NEPTUN при цьому показує одну модельку. Не плутаємо
     * це з кількістю окремих маркерів у кластері.
     */

    const clusterCount =
      Number(
        t._clusterCount
      );


    const count =
      Number.isFinite(clusterCount) &&
      clusterCount > 1

        ? `
          <span
            class="threat-count"
          >
            ${this.escape(
              clusterCount
            )}
          </span>
        `

        : "";


    return L.divIcon({

      className:"",

      html:`

        <div
          class="
            threat-hitbox
            threat-${model}
          "
        >

          <div
            class="threat-symbol"

            style="
              width:${visualSize}px;
              height:${visualSize}px;

              color:${color};

              transform:
                ${rotation};
            "
          >

            ${symbol}

          </div>

          ${count}

        </div>
      `,

      iconSize:[
        hitboxSize,
        hitboxSize
      ],

      iconAnchor:[
        hitboxSize / 2,
        hitboxSize / 2
      ]
    });
  }


  /* =========================================================
     THREATS
     ========================================================= */

  renderThreats() {

    const threats =
      this._snapshot
        .threats || [];


    const active =
      new Set();


    for (
      const threat
      of threats
    ) {

      if (!threat?.id)
        continue;


      const lat =
        Number(
          threat.lat
        );


      const lon =
        Number(
          threat.lon
        );


      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      )
        continue;


      active.add(
        threat.id
      );


      let marker =
        this._markers.get(
          threat.id
        );


      if (!marker) {

        marker =
          L.marker(
            [lat,lon],
            {

              pane:"threats",

              icon:
                this.makeThreatIcon(
                  threat
                ),

              keyboard:false,

              zIndexOffset:1000,

              riseOnHover:true
            }
          );


        marker.addTo(
          this._map
        );


        /*
         * New marker already owns the correct icon; store its
         * signature after the common update block below decides
         * whether a replacement is needed.
         */
        marker._iconSignature = null;


        marker.on(
          "click",
          e => {

            L.DomEvent
              .stopPropagation(
                e
              );


            const current =
              marker._threat;


            if (current) {

              this.openInfo(
                current
              );
            }
          }
        );


        this._markers.set(
          threat.id,
          marker
        );
      }


      /*
       * Rebuilding a Leaflet divIcon replaces marker DOM. Realtime
       * snapshots can arrive even when the visual icon did not
       * change, so keep a compact visual signature and only touch
       * the DOM when necessary.
       */

      const iconSignature = [
        this.getThreatModel(threat),
        threat.type || "",
        threat.heading ?? "",
        threat.areaOnly ? 1 : 0,
        threat.title || "",
        window.NEPTUN?.getTypeMeta?.(
          threat.type
        )?.color || ""
      ].join("|");


      marker._threat =
        threat;


      marker._realLatLng =
        L.latLng(
          lat,
          lon
        );


      if (
        marker._iconSignature !==
        iconSignature
      ) {

        marker.setIcon(
          this.makeThreatIcon(
            threat
          )
        );

        marker._iconSignature =
          iconSignature;
      }
    }


    /*
     * Видаляємо цілі,
     * яких більше немає у snapshot.
     */

    for (
      const [id,marker]
      of this._markers
    ) {

      if (
        !active.has(id)
      ) {

        marker.remove();

        this._markers.delete(
          id
        );
      }
    }


    this._lastIconZoomBucket =
      this.getZoomBucket();


    this.scheduleThreatClustering();
  }


  /*
   * Coalesce all clustering requests into one animation frame.
   * Snapshot, zoom/move end and prediction can request a refresh
   * almost simultaneously; only the newest map state matters.
   */
  scheduleThreatClustering() {

    if (
      !this._map ||
      this._mapInteracting ||
      this._clusterPending
    )
      return;


    this._clusterPending = true;


    this._clusterRaf =
      requestAnimationFrame(
        () => {

          this._clusterPending = false;
          this._clusterRaf = null;

          if (
            !this._map ||
            this._mapInteracting
          )
            return;

          this.applyThreatClustering();
        }
      );
  }


  /* =========================================================
     UPDATE THREAT APPEARANCE
     ========================================================= */

  updateThreatAppearance(
    forceIcons = false
  ) {

    if (!this._map)
      return;


    const bucket =
      this.getZoomBucket();


    /*
     * SVG не треба перебудовувати
     * на кожному pixel move.
     *
     * Перебудовуємо тільки коли
     * змінився zoom bucket.
     */

    if (
      forceIcons ||
      bucket !==
        this._lastIconZoomBucket
    ) {

      for (
        const marker
        of this._markers.values()
      ) {

        if (!marker._threat)
          continue;


        marker.setIcon(
          this.makeThreatIcon(
            marker._threat
          )
        );
      }


      this._lastIconZoomBucket =
        bucket;
    }


    this.scheduleThreatClustering();
  }


  /* =========================================================
     THREAT CLUSTERING
     ========================================================= */

  applyThreatClustering() {

    if (
      !this._map ||
      this._mapInteracting
    )
      return;


    /*
     * Кожен запуск отримує власне покоління.
     * Це важливо, бо clustering викликається і зі snapshot,
     * і з animation loop, і після zoom. Старий click-handler
     * не повинен працювати після наступного перерахунку.
     */

    const revision =
      ++this._clusterRevision;


    /*
     * Persistent cluster pool. A stable key derived from member IDs
     * lets us reuse the same Leaflet marker across animation passes
     * instead of remove()+new L.marker()+addTo() every time.
     */
    const activeClusterKeys =
      new Set();


    const zoom =
      this._map.getZoom();


    const min =
      this._minimumZoom || zoom;


    const delta =
      zoom - min;


    let threshold;


    if (delta < .75)
      threshold = 30;

    else if (delta < 1.5)
      threshold = 24;

    else if (delta < 2.5)
      threshold = 17;

    else if (delta < 3.5)
      threshold = 11;

    else
      threshold = 7;


    /*
     * На максимальному zoom взагалі не кластеризуємо.
     * Кожен окремий запис NEPTUN показується своєю
     * моделькою точно на своїй координаті.
     */

    const clusteringEnabled =
      zoom < this._map.getMaxZoom();


    const items = [];


    for (
      const marker
      of this._markers.values()
    ) {

      if (
        !marker._threat ||
        marker._threat.areaOnly
      )
        continue;


      const latlng =
        marker._predictedLatLng ||
        marker._realLatLng;


      if (!latlng)
        continue;


      marker.setLatLng(
        latlng
      );


      marker.setOpacity(1);


      const el =
        marker.getElement();


      if (el)
        el.style.pointerEvents = "";


      items.push({

        marker,
        latlng,

        point:
          this._map.latLngToLayerPoint(
            latlng
          )
      });
    }


    const used =
      new Set();


    for (
      let i = 0;
      i < items.length;
      i++
    ) {

      if (used.has(i))
        continue;


      const group = [i];

      used.add(i);


      if (!clusteringEnabled)
        continue;


      let changed = true;


      while (changed) {

        changed = false;


        for (
          let j = 0;
          j < items.length;
          j++
        ) {

          if (used.has(j))
            continue;


          const near =
            group.some(
              index => {

                const dx =
                  items[j].point.x -
                  items[index].point.x;


                const dy =
                  items[j].point.y -
                  items[index].point.y;


                return Math.sqrt(
                  dx * dx +
                  dy * dy
                ) < threshold;
              }
            );


          if (near) {

            group.push(j);
            used.add(j);
            changed = true;
          }
        }
      }


      if (group.length <= 1)
        continue;


      let x = 0;
      let y = 0;


      const members =
        group.map(
          index => {

            const item =
              items[index];


            x += item.point.x;
            y += item.point.y;


            item.marker.setOpacity(0);


            const el =
              item.marker.getElement();


            if (el)
              el.style.pointerEvents = "none";


            return {
              marker:item.marker,
              latlng:item.latlng,
              threat:item.marker._threat
            };
          }
        );


      x /= members.length;
      y /= members.length;


      const center =
        this._map.layerPointToLatLng(
          L.point(x,y)
        );


      /*
       * Badge кластера = кількість ОКРЕМИХ маркерів,
       * які ми сховали під однією моделькою.
       * Внутрішній NEPTUN threat.count сюди не додаємо.
       */

      const count =
        members.length;


      /*
       * У змішаному кластері значок визначається не порядком
       * цілей у snapshot, а явним пріоритетом типів.
       */

      const clusterPriority = {
        aircraft:0,
        mig31k:1,
        ballistic:2,
        missile:3,
        shahed_jet:4,
        shahed:5,
        recon:6,
        fpv:7,
        kab:8,
        unknown:9
      };


      const representative =
        members.reduce(
          (best,member) => {

            if (!best)
              return member.threat;


            const bestModel =
              this.getThreatModel(
                best
              );


            const memberModel =
              this.getThreatModel(
                member.threat
              );


            const bestPriority =
              clusterPriority[bestModel] ??
              clusterPriority.unknown;


            const memberPriority =
              clusterPriority[memberModel] ??
              clusterPriority.unknown;


            return memberPriority < bestPriority
              ? member.threat
              : best;
          },
          null
        );


      const clusterThreat = {
        ...representative,
        _clusterCount:count
      };


      const clusterKey =
        members
          .map(
            item =>
              String(
                item.threat?.id || ""
              )
          )
          .sort()
          .join("|");


      activeClusterKeys.add(
        clusterKey
      );


      let cluster =
        this._clusterPool.get(
          clusterKey
        );


      const clusterIconSignature = [
        this.getThreatModel(
          clusterThreat
        ),
        clusterThreat.type || "",
        clusterThreat.heading ?? "",
        count,
        window.NEPTUN?.getTypeMeta?.(
          clusterThreat.type
        )?.color || "",
        this.getZoomBucket()
      ].join("|");


      if (!cluster) {

        cluster =
          L.marker(
            center,
            {
              pane:"threats",
              keyboard:false,
              zIndexOffset:1200,
              icon:
                this.makeThreatIcon(
                  clusterThreat
                )
            }
          )
          .addTo(
            this._map
          );


        cluster._clusterIconSignature =
          clusterIconSignature;


        /*
         * Event handlers are attached once for the lifetime of the
         * pooled marker. Current members/center are stored on the
         * marker and refreshed below on every clustering pass.
         */
        const openCluster =
          e => {

            L.DomEvent
              .stopPropagation(
                e
              );


            const currentMembers =
              cluster._clusterMembers ||
              [];


            const currentCenter =
              cluster._clusterCenter ||
              cluster.getLatLng();


            const bounds =
              L.latLngBounds(
                currentMembers.map(
                  item =>
                    item.latlng
                )
              );


            if (
              bounds.isValid() &&
              !bounds.getNorthEast()
                .equals(
                  bounds.getSouthWest()
                )
            ) {

              this._map.fitBounds(
                bounds,
                {
                  padding:[45,45],
                  maxZoom:11,
                  animate:true
                }
              );

            }

            else {

              this._map.setView(
                currentCenter,
                Math.min(
                  11,
                  this._map.getZoom() + 2
                ),
                {
                  animate:true
                }
              );
            }
          };


        cluster.on(
          "mousedown",
          e => {

            const original =
              e.originalEvent;


            if (
              original &&
              original.button === 0
            )
              openCluster(e);
          }
        );


        cluster.on(
          "click",
          e => {

            const original =
              e.originalEvent;


            if (
              original &&
              original.pointerType === "mouse"
            )
              return;


            openCluster(e);
          }
        );


        this._clusterPool.set(
          clusterKey,
          cluster
        );

      }

      else {

        cluster.setLatLng(
          center
        );


        if (
          cluster._clusterIconSignature !==
          clusterIconSignature
        ) {

          cluster.setIcon(
            this.makeThreatIcon(
              clusterThreat
            )
          );

          cluster._clusterIconSignature =
            clusterIconSignature;
        }
      }


      cluster._clusterMembers =
        members;

      cluster._clusterCenter =
        center;

      cluster._clusterRevision =
        revision;
    }


    /*
     * Remove only clusters whose membership disappeared. Stable
     * groups remain mounted in the DOM and are simply repositioned.
     */
    for (
      const [key,cluster]
      of this._clusterPool
    ) {

      if (
        activeClusterKeys.has(
          key
        )
      )
        continue;


      cluster.remove();

      this._clusterPool.delete(
        key
      );
    }


    this._clusterMarkers =
      [...this._clusterPool.values()];
  }


  /* =========================================================
     TYPE COLORS
     ========================================================= */

  typeColor(
    type,
    model = null
  ) {

    const t =
      String(
        type || ""
      )
        .toLowerCase()
        .trim();


    const m =
      model ||
      "";


    if (
      m === "fpv" ||
      t === "fpv"
    )
      return "#ff8a3d";


    if (
      m === "shahed_jet"
    )
      return "#ff4f32";


    if (
      m === "shahed" ||
      t === "uav"
    )
      return "#ff6338";


    if (
      m === "ballistic" ||
      t === "ballistic"
    )
      return "#ff1744";


    if (
      m === "missile" ||
      t === "missile"
    )
      return "#ff3d4d";


    if (
      m === "kab" ||
      t === "kab" ||
      t === "bomb"
    )
      return "#ffc02e";


    if (
      m === "recon" ||
      t === "recon"
    )
      return "#ffd740";


    if (
      m === "mig31k" ||
      t === "mig31k" ||
      t === "mig-31k"
    )
      return "#cf8cff";


    if (
      m === "aircraft" ||
      t === "aircraft" ||
      t === "plane"
    )
      return "#9ccfff";


    return "#eeeeee";
  }


  /* =========================================================
     TYPE NAMES
     ========================================================= */

  typeName(type) {

    const t =
      String(
        type || ""
      )
        .toLowerCase()
        .trim();


    const names = {

      fpv:
        "FPV-дрон",

      uav:
        "БпЛА",

      jet_uav:
        "Реактивний БпЛА",

      "jet-uav":
        "Реактивний БпЛА",

      shahed_jet:
        "Реактивний Shahed",

      "shahed-238":
        "Shahed-238",

      recon:
        "Розвідувальний БпЛА",

      missile:
        "Ракета",

      ballistic:
        "Балістична ракета",

      kab:
        "КАБ",

      bomb:
        "Авіабомба",

      mig31k:
        "МіГ-31К",

      "mig-31k":
        "МіГ-31К",

      aircraft:
        "Літак",

      plane:
        "Літак"
    };


    return (
      names[t] ||
      "Повітряна ціль"
    );
  }


  /* =========================================================
     INFO PANEL
     ========================================================= */

  openInfo(threat) {

    if (!threat)
      return;


    this._selectedThreat =
      threat;


    this.renderInfo(
      threat
    );


    const panel =
      this.shadowRoot
        ?.querySelector(
          "#info-panel"
        );


    if (panel) {

      panel.classList.add(
        "open"
      );
    }
  }


  closeInfo() {

    this._selectedThreat =
      null;


    const panel =
      this.shadowRoot
        ?.querySelector(
          "#info-panel"
        );


    if (panel) {

      panel.classList.remove(
        "open"
      );
    }
  }


  renderInfo(t) {

    const container =
      this.shadowRoot
        ?.querySelector(
          "#info-content"
        );


    if (!container)
      return;


    const model =
      this.getThreatModel(
        t
      );


    const title =
      t.title ||
      t.name ||
      t.model ||
      this.typeName(
        t.type
      );


    /*
     * ---------------------------------------------------------
     * LOCATION
     * ---------------------------------------------------------
     */

    const locationParts = [];


    if (t.region) {

      locationParts.push(
        t.region
      );
    }


    if (
      t.district &&
      !locationParts.includes(
        t.district
      )
    ) {

      locationParts.push(
        t.district
      );
    }


    if (
      t.locality &&
      !locationParts.includes(
        t.locality
      )
    ) {

      locationParts.push(
        t.locality
      );
    }


    const location =
      locationParts
        .filter(Boolean)
        .join(" · ");


    /*
     * ---------------------------------------------------------
     * HEADING
     * ---------------------------------------------------------
     */

    const heading =
      Number(
        t.heading
      );


    /*
     * ---------------------------------------------------------
     * CONFIDENCE
     * ---------------------------------------------------------
     */

    const confidence =
      t.confidenceLevel ||
      t.confidence ||
      "";


    /*
     * ---------------------------------------------------------
     * COUNT
     * ---------------------------------------------------------
     */

    const count =
      Number(
        t.count
      );


    /*
     * ---------------------------------------------------------
     * DESCRIPTION
     * ---------------------------------------------------------
     */

    const description =
      t.explanationShort ||
      t.description ||
      "";


    /*
     * ---------------------------------------------------------
     * INFO ITEMS
     * ---------------------------------------------------------
     */

    const items = [];


    if (
      Number.isFinite(heading) &&
      !t.areaOnly
    ) {

      items.push(
        `
          <span
            class="info-item"
          >
            Курс:
            <b>
              ${Math.round(
                heading
              )}°
            </b>
          </span>
        `
      );
    }


    if (confidence) {

      items.push(
        `
          <span
            class="info-item"
          >
            Достовірність:
            <b>
              ${this.escape(
                confidence
              )}
            </b>
          </span>
        `
      );
    }


    if (
      Number.isFinite(count) &&
      count > 1
    ) {

      items.push(
        `
          <span
            class="info-item"
          >
            Кількість:
            <b>
              ${this.escape(
                count
              )}
            </b>
          </span>
        `
      );
    }


    /*
     * Тип додаємо тільки якщо він
     * реально дає корисну інформацію.
     */

    const readableType =
      this.typeName(
        t.type
      );


    if (
      readableType &&
      readableType !== title
    ) {

      items.push(
        `
          <span
            class="info-item"
          >
            Тип:
            <b>
              ${this.escape(
                readableType
              )}
            </b>
          </span>
        `
      );
    }


    /*
     * Для реактивного Shahed можемо
     * додатково показати модель,
     * навіть якщо NEPTUN передав просто UAV.
     */

    if (
      model === "shahed_jet" &&
      !String(title)
        .toLowerCase()
        .includes("238")
    ) {

      items.push(
        `
          <span
            class="info-item"
          >
            Модель:
            <b>
              реактивний Shahed
            </b>
          </span>
        `
      );
    }


    container.innerHTML = `

      <div
        class="info-title"
      >
        ${this.escape(
          title
        )}
      </div>


      ${
        location

          ? `
            <div
              class="info-location"
            >
              ${this.escape(
                location
              )}
            </div>
          `

          : ""
      }


      ${
        items.length

          ? `
            <div
              class="info-grid"
            >
              ${items.join("")}
            </div>
          `

          : ""
      }


      ${
        description

          ? `
            <div
              class="info-description"
            >
              ${this.escape(
                description
              )}
            </div>
          `

          : ""
      }


      ${
        t.areaOnly

          ? `
            <div
              class="info-area-note"
            >
              Координата приблизна:
              NEPTUN передає цю загрозу
              на рівні району або області.
            </div>
          `

          : ""
      }
    `;
  }


  /* =========================================================
     ANIMATION
     ========================================================= */

  startAnimation() {

    if (this._animation)
      return;


    /*
     * requestAnimationFrame still wakes up every display frame even
     * when we immediately return. Keep the loop, but do real NEPTUN
     * prediction at 10 Hz and clustering at most ~3 Hz, only when
     * coordinates actually changed.
     */
    const frame = timestamp => {

      if (!this._map) {

        this._animation = null;
        return;
      }


      if (
        this._mapInteracting ||
        document.hidden
      ) {

        this._animation =
          requestAnimationFrame(
            frame
          );

        return;
      }


      if (
        timestamp -
        this._animationLastPrediction <
        this._predictionInterval
      ) {

        this._animation =
          requestAnimationFrame(
            frame
          );

        return;
      }


      this._animationLastPrediction =
        timestamp;


      const now =
        Date.now();


      let moved =
        false;


      for (
        const marker
        of this._markers.values()
      ) {

        const threat =
          marker._threat;


        if (
          !threat ||
          threat.areaOnly
        )
          continue;


        let predicted =
          null;


        try {

          if (
            window.NEPTUN &&
            typeof window.NEPTUN.predict ===
              "function"
          ) {

            predicted =
              window.NEPTUN.predict(
                threat,
                now
              );
          }

        }

        catch(e) {}


        let lat =
          Number(
            predicted?.lat ??
            predicted?.latitude
          );


        let lon =
          Number(
            predicted?.lon ??
            predicted?.lng ??
            predicted?.longitude
          );


        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon)
        ) {

          lat =
            Number(
              threat.lat
            );

          lon =
            Number(
              threat.lon
            );
        }


        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon)
        )
          continue;


        const previous =
          marker._predictedLatLng;


        if (
          !previous ||
          Math.abs(previous.lat - lat) >
            this._clusterMoveEpsilon ||
          Math.abs(previous.lng - lon) >
            this._clusterMoveEpsilon
        ) {

          marker._predictedLatLng =
            L.latLng(
              lat,
              lon
            );

          moved = true;
        }
      }


      /*
       * Static snapshots no longer rebuild cluster marker DOM forever.
       * A cluster pass happens only after meaningful predicted movement,
       * and is rate-limited independently from prediction.
       */
      if (
        moved &&
        timestamp -
          this._animationLastCluster >=
          this._clusterInterval
      ) {

        this.scheduleThreatClustering();

        this._animationLastCluster =
          timestamp;
      }


      this._animation =
        requestAnimationFrame(
          frame
        );
    };


    this._animationLastPrediction = 0;
    this._animationLastCluster = 0;


    this._animation =
      requestAnimationFrame(
        frame
      );
  }

  /* =========================================================
     STATUS
     ========================================================= */

  status(text) {

    const el =
      this.shadowRoot
        ?.querySelector(
          "#status"
        );


    if (!el)
      return;


    el.textContent =
      text;


    el.classList.remove(
      "hidden"
    );
  }


  hideStatus() {

    const el =
      this.shadowRoot
        ?.querySelector(
          "#status"
        );


    if (!el)
      return;


    el.classList.add(
      "hidden"
    );
  }


  /* =========================================================
     ESCAPE HTML
     ========================================================= */

  escape(value) {

    return String(
      value ??
      ""
    )

      .replaceAll(
        "&",
        "&amp;"
      )

      .replaceAll(
        "<",
        "&lt;"
      )

      .replaceAll(
        ">",
        "&gt;"
      )

      .replaceAll(
        '"',
        "&quot;"
      )

      .replaceAll(
        "'",
        "&#039;"
      );
  }


  /* =========================================================
     HOME ASSISTANT CARD SIZE
     ========================================================= */

  getCardSize() {

    return 6;
  }


  /* =========================================================
     CLEANUP
     ========================================================= */

  connectedCallback() {

    /*
     * Home Assistant на мобільному може тимчасово прибрати
     * картку з DOM при переході між Lovelace views.
     * disconnectedCallback() коректно знищує Leaflet/NEPTUN,
     * тому при поверненні треба запустити їх знову.
     */

    if (
      this._configSet &&
      !this._map
    )
      this.scheduleStart();
  }


  disconnectedCallback() {

    /*
     * Animation loop.
     */

    if (
      this._animation
    ) {

      cancelAnimationFrame(
        this._animation
      );

      this._animation =
        null;
    }


    this._animationLastPrediction = 0;
    this._animationLastCluster = 0;


    /*
     * Pending clustering frame.
     */

    if (
      this._clusterRaf
    ) {

      cancelAnimationFrame(
        this._clusterRaf
      );

      this._clusterRaf = null;
      this._clusterPending = false;
    }


    /*
     * ResizeObserver.
     */

    if (
      this._resizeObserver
    ) {

      try {

        this._resizeObserver
          .disconnect();

      }
      catch(e) {}


      this._resizeObserver =
        null;
    }


    /*
     * NEPTUN subscription.
     */

    if (
      this._unsubscribe
    ) {

      try {

        if (
          typeof this._unsubscribe ===
          "function"
        ) {

          this._unsubscribe();
        }

      }
      catch(e) {}


      this._unsubscribe =
        null;
    }


    /*
     * NEPTUN client.
     */

    if (
      this._client
    ) {

      try {

        if (
          typeof this._client.stop ===
          "function"
        ) {

          this._client.stop();
        }

      }
      catch(e) {}


      this._client =
        null;
    }


    /*
     * Leaflet map.
     */

    if (
      this._map
    ) {

      try {

        this._map.remove();

      }
      catch(e) {}


      this._map =
        null;
    }


    this._markers.clear();


    for (
      const cluster
      of this._clusterPool.values()
    ) {

      try {
        cluster.remove();
      }
      catch(e) {}
    }


    this._clusterPool.clear();
    this._clusterMarkers = [];

    this._oblastLabels = [];

    this._cityLabels = [];

    /*
     * Ці прапорці/посилання належать конкретному екземпляру
     * Leaflet map. Після повернення view вони мають бути
     * створені заново.
     */

    this._raionsLoaded = false;
    this._raionLayer = null;
    this._raionBoundaryLayer = null;
    this._raionBoundaryGeoJSON = null;
    this._raionClipAssignments = null;
    this._raionClipDefs = null;
    this._raionClipPaths.clear();
    this._oblastLayer = null;
    this._oblastBorderLayer = null;
    this._oblastGeoJSON = null;
    this._kyivBoundaryLoaded = false;
    this._kyivBoundary = null;
    this._ukraineBounds = null;
    this._ukraineRealBounds = null;
  }

}


/* ===========================================================
   CUSTOM ELEMENT
   =========================================================== */

if (
  !customElements.get(
    "ha-neptun-map"
  )
) {

  customElements.define(
    "ha-neptun-map",
    HANeptunMap
  );
}


/* ===========================================================
   HOME ASSISTANT CARD PICKER
   =========================================================== */

window.customCards =
  window.customCards || [];


if (
  !window.customCards.some(
    card =>
      card.type ===
      "ha-neptun-map"
  )
) {

  window.customCards.push({

    type:
      "ha-neptun-map",

    name:
      "HA NEPTUN Map",

    description:
      "Карта повітряних загроз NEPTUN для Home Assistant",

    preview:
      true
  });
}


/* ===========================================================
   VERSION
   =========================================================== */

console.info(
  "%c HA NEPTUN MAP v0.0.1-beta.1 ",
  "background:#263238;color:#fff;padding:3px 7px;border-radius:4px;font-weight:bold;"
);
