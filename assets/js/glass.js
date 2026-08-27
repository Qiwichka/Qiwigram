/*
 * glass.js — стеклянный бублик над надписью, для главной страницы Qiwigram.
 *
 * Порт компонента Framer "Glass Icon" (Originkit) на чистый WebGL без React,
 * без motion/react и без three.js. Что выкинуто по сравнению с оригиналом:
 *
 *   - все формы кроме тора (X / Sphere / Logo) вместе со всей машинерией
 *     запекания SDF из PNG — это примерно половина исходного файла
 *   - режимы фона Image / Video — здесь фон только текстовый
 *   - React, useEffect, motionValue; плавность наклона сделана
 *     экспоненциальным приближением (как в самом первоисточнике до
 *     переписывания на motion)
 *
 * Модель освещения оставлена термин в термин: экранное преломление подложки
 * с раздельным IOR по каналам, линзовое искажение ядра, 24-точечный
 * фростовый блюр по спирали Фогеля, отражение студийного софтбокса из
 * equirect-карты и смешение по Френелю.
 */

(function () {
    "use strict"

    /* ------------------------------------------------------------------ */
    /* параметры сцены — то, чем компонент был настроен в Framer           */
    /* ------------------------------------------------------------------ */

    var BEVEL = 0.025
    var CORE_REFRACT = 1.0
    var IOR = 1.5
    var THICKNESS = 2.0
    var IDLE_FLOAT = 0.05 // амплитуда покачивания, мировые единицы
    var TILT_RANGE = 0.5 // курсор -> +-0.5 рад
    var TILT_RATE = 5 // скорость возврата наклона, 1/сек
    var DRAG_GAIN = 0.01
    var SPIN_YAW = 0.5
    var SPIN_PITCH = 0.2
    var FOV = (45 * Math.PI) / 180
    var CAM_DIST = 5

    /* ------------------------------------------------------------------ */
    /* цвет                                                                */
    /* ------------------------------------------------------------------ */

    function parseColor(input, fallback) {
        if (!input) return fallback
        var s = String(input).trim()
        if (s.charAt(0) === "#") {
            var h = s.slice(1)
            if (h.length === 3 || h.length === 4) {
                h = h.split("").map(function (c) { return c + c }).join("")
            }
            if (h.length >= 6) {
                var r = parseInt(h.slice(0, 2), 16) / 255
                var g = parseInt(h.slice(2, 4), 16) / 255
                var b = parseInt(h.slice(4, 6), 16) / 255
                if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b]
            }
            return fallback
        }
        var m = s.match(/rgba?\(([^)]+)\)/i)
        if (m) {
            var p = m[1].split(",").map(parseFloat)
            if (p.length >= 3) return [p[0] / 255, p[1] / 255, p[2] / 255]
        }
        return fallback
    }

    /* ------------------------------------------------------------------ */
    /* матрицы 3x3, по столбцам                                            */
    /* ------------------------------------------------------------------ */

    /** Рыскание вокруг Y, затем тангаж вокруг X: R = Ry * Rx. */
    function rotYX(yaw, pitch) {
        var cy = Math.cos(yaw), sy = Math.sin(yaw)
        var cx = Math.cos(pitch), sx = Math.sin(pitch)
        var m = new Float32Array(9)
        m[0] = cy;      m[1] = 0;   m[2] = -sy
        m[3] = sy * sx; m[4] = cx;  m[5] = cy * sx
        m[6] = sy * cx; m[7] = -sx; m[8] = cy * cx
        return m
    }

    function transpose3(m) {
        var o = new Float32Array(9)
        o[0] = m[0]; o[1] = m[3]; o[2] = m[6]
        o[3] = m[1]; o[4] = m[4]; o[5] = m[7]
        o[6] = m[2]; o[7] = m[5]; o[8] = m[8]
        return o
    }

    /* ------------------------------------------------------------------ */
    /* окружение — студийный софтбокс, equirect 1024x512                   */
    /* ------------------------------------------------------------------ */

    /*
     * Именно эта карта даёт бублику блики. Без неё прозрачному стеклу
     * нечего отражать и оно выглядит как мутный полиэтилен.
     */
    function buildEnvCanvas() {
        var canvas = document.createElement("canvas")
        canvas.width = 1024
        canvas.height = 512
        var ctx = canvas.getContext("2d")
        if (!ctx) return null
        ctx.fillStyle = "#1a1a1a"
        ctx.fillRect(0, 0, 1024, 512)

        function softbox(x, y, w, h, intensity) {
            var grd = ctx.createLinearGradient(x, y, x, y + h)
            grd.addColorStop(0, "rgba(255,255,255," + intensity + ")")
            grd.addColorStop(1, "rgba(50,50,50," + intensity * 0.2 + ")")
            ctx.fillStyle = grd
            ctx.shadowColor = "#ffffff"
            ctx.shadowBlur = 80
            ctx.beginPath()
            if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, 60)
            else ctx.rect(x, y, w, h)
            ctx.fill()
        }
        softbox(50, 100, 300, 312, 1)
        softbox(674, 100, 300, 312, 1)
        softbox(350, -50, 324, 150, 0.9)
        ctx.shadowBlur = 0
        return canvas
    }

    /* ------------------------------------------------------------------ */
    /* шейдеры — GLSL ES 1.00                                              */
    /* ------------------------------------------------------------------ */

    var FULLSCREEN_VS =
        "attribute vec2 aPos;\n" +
        "void main() { gl_Position = vec4(aPos, 0.0, 1.0); }"

    /* Подложка: вписана по принципу cover — та самая плоскость, которую
     * оригинал рендерил в отдельный буфер только ради того, чтобы стекло
     * могло её читать. Плоскость точно закрывает кадр, поэтому буфер и есть
     * экран, и считать его можно аналитически. */
    var PLATE_FS =
        "precision highp float;\n" +
        "uniform sampler2D uPlate;\n" +
        "uniform vec2 uPlateFit;\n" +
        "uniform vec2 uRes;\n" +
        "void main() {\n" +
        "    vec2 uv = (gl_FragCoord.xy / uRes - 0.5) * uPlateFit + 0.5;\n" +
        "    gl_FragColor = texture2D(uPlate, clamp(uv, 0.0, 1.0));\n" +
        "}"

    /* Тело стекла. SAMPLES и STEPS подставляются при сборке строки: границы
     * циклов в GLSL ES 1.00 обязаны быть константами, а на телефоне их надо
     * урезать, иначе первая же страница начинает греть аппарат. */
    function glassFS(samples, steps) {
        return [
            "precision highp float;",
            "",
            "uniform vec2 uRes;",
            "uniform float uAspect;",
            "uniform float uTanHalf;",
            "",
            "uniform sampler2D uPlate;",
            "uniform vec2 uPlateFit;",
            "uniform float uHasPlate;",
            "uniform sampler2D uEnv;",
            "",
            "uniform mat3 uRot;",       // объект -> вид
            "uniform mat3 uRotT;",      // вид -> объект
            "uniform vec3 uCenter;",    // центр объекта в пространстве вида
            "uniform float uScale;",
            "uniform float uBoundR;",
            "uniform float uTorusTube;",
            "",
            "uniform float uDisp;",
            "uniform float uFrost;",
            "uniform vec3 uTint;",
            "",
            "const float PI = 3.14159265359;",
            "const float CORE_REFRACT = " + CORE_REFRACT.toFixed(4) + ";",
            "const float IOR = " + IOR.toFixed(4) + ";",
            "const float THICKNESS = " + THICKNESS.toFixed(4) + ";",
            "",
            // тор лежит в плоскости XY, дырка смотрит вдоль Z — так же, как
            // TorusGeometry в оригинале
            "float map(vec3 p) {",
            "    vec2 q = vec2(length(p.xy) - 0.8, p.z);",
            "    return length(q) - uTorusTube;",
            "}",
            "",
            "vec3 mapNormal(vec3 p) {",
            "    const float e = 0.0015;",
            "    vec2 k = vec2(1.0, -1.0);",
            "    return normalize(",
            "        k.xyy * map(p + k.xyy * e) +",
            "        k.yyx * map(p + k.yyx * e) +",
            "        k.yxy * map(p + k.yxy * e) +",
            "        k.xxx * map(p + k.xxx * e)",
            "    );",
            "}",
            "",
            "vec4 plate(vec2 screenUv) {",
            "    if (uHasPlate < 0.5) return vec4(0.0);",
            "    vec2 uv = (screenUv - 0.5) * uPlateFit + 0.5;",
            "    return texture2D(uPlate, clamp(uv, 0.0, 1.0));",
            "}",
            "",
            "float rand(vec2 co) {",
            "    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);",
            "}",
            "",
            "void main() {",
            "    vec2 screenUv = gl_FragCoord.xy / uRes;",
            "    vec2 ndc = screenUv * 2.0 - 1.0;",
            "",
            // камера в начале координат вида, смотрит вдоль -Z
            "    vec3 D = normalize(vec3(ndc.x * uTanHalf * uAspect, ndc.y * uTanHalf, -1.0));",
            "    vec3 rd = normalize(uRotT * D);",
            "    vec3 ro = (uRotT * -uCenter) / uScale;",
            "",
            // отсечение по габаритной сфере: без него марш оплачивает каждый
            // пиксель экрана, а тело занимает малую его часть
            "    float bb = dot(ro, rd);",
            "    float cc = dot(ro, ro) - uBoundR * uBoundR;",
            "    float hh = bb * bb - cc;",
            "    if (hh < 0.0) discard;",
            "    hh = sqrt(hh);",
            "    float t = max(-bb - hh, 0.0);",
            "    float tMax = -bb + hh;",
            "",
            "    bool hit = false;",
            "    for (int i = 0; i < " + steps + "; i++) {",
            "        if (t > tMax) break;",
            "        float d = map(ro + rd * t);",
            "        if (d < 0.0009) { hit = true; break; }",
            "        t += d * 0.9;",
            "    }",
            "    if (!hit) discard;",
            "",
            "    vec3 pObj = ro + rd * t;",
            "    vec3 nObj = mapNormal(pObj);",
            "",
            "    vec3 vP = uCenter + uScale * (uRot * pObj);",
            "    vec3 normal = normalize(uRot * nObj);",
            "    vec3 viewDir = normalize(-vP);",
            "",
            "    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 4.0);",
            "",
            "    float coreFactor = pow(max(dot(normal, viewDir), 0.0), 2.0);",
            "    vec2 lensOffset = (screenUv - 0.5) * (CORE_REFRACT * 0.15) * coreFactor;",
            "",
            "    vec3 refractView = refract(-viewDir, normal, 1.0 / IOR);",
            "    vec2 offset = refractView.xy * (THICKNESS * 0.1) - lensOffset;",
            "",
            // камера не повёрнута, поэтому вид и мир смотрят одинаково и
            // отражению не нужен второй базис
            "    vec3 reflectDir = reflect(-viewDir, normal);",
            "    vec2 equirectUv = vec2(",
            "        atan(reflectDir.z, reflectDir.x) / (2.0 * PI) + 0.5,",
            "        asin(clamp(reflectDir.y, -1.0, 1.0)) / PI + 0.5",
            "    );",
            "    vec3 reflection = texture2D(uEnv, equirectUv).rgb * 2.5;",
            "",
            "    vec3 transmission = vec3(0.0);",
            "    float bgAlpha = 0.0;",
            "",
            "    vec2 uvR = screenUv + offset * (1.0 + uDisp);",
            "    vec2 uvG = screenUv + offset;",
            "    vec2 uvB = screenUv + offset * (1.0 - uDisp);",
            "",
            "    if (uFrost > 0.001) {",
            "        float rnd = rand(screenUv) * 6.2831853;",
            "        const int SAMPLES = " + samples + ";",
            "        const float GOLDEN_ANGLE = 2.39996323;",
            "        float radius = 0.0;",
            "        float radiusStep = 1.0 / float(SAMPLES);",
            "        float blurMultiplier = uFrost * 0.025;",
            "        for (int i = 0; i < " + samples + "; i++) {",
            "            float theta = float(i) * GOLDEN_ANGLE + rnd;",
            "            radius += radiusStep;",
            "            vec2 bo = vec2(cos(theta), sin(theta)) * radius * blurMultiplier;",
            "            transmission.r += plate(uvR + bo).r;",
            "            vec4 g = plate(uvG + bo);",
            "            transmission.g += g.g;",
            "            bgAlpha += g.a;",
            "            transmission.b += plate(uvB + bo).b;",
            "        }",
            "        transmission /= float(SAMPLES);",
            "        bgAlpha /= float(SAMPLES);",
            "    } else {",
            "        transmission.r = plate(uvR).r;",
            "        vec4 g = plate(uvG);",
            "        transmission.g = g.g;",
            "        bgAlpha = g.a;",
            "        transmission.b = plate(uvB).b;",
            "    }",
            "",
            "    transmission *= uTint;",
            "",
            // за телом может не быть ничего — тогда стекло должно читаться
            // белым, а не чёрным
            "    vec3 clearGlassTint = mix(uTint, reflection, 0.5);",
            "    transmission = mix(clearGlassTint, transmission, bgAlpha);",
            "",
            "    vec3 finalColor = mix(transmission, reflection, fresnel * 0.8);",
            "",
            "    float baseAlpha = max(0.25, fresnel * 0.85);",
            "    float outAlpha = mix(baseAlpha, 1.0, bgAlpha);",
            "",
            "    gl_FragColor = vec4(finalColor, outAlpha);",
            "}"
        ].join("\n")
    }

    function compile(gl, type, src) {
        var s = gl.createShader(type)
        gl.shaderSource(s, src)
        gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.warn("glass shader:", gl.getShaderInfoLog(s))
            gl.deleteShader(s)
            return null
        }
        return s
    }

    function link(gl, vs, fs) {
        var v = compile(gl, gl.VERTEX_SHADER, vs)
        var f = compile(gl, gl.FRAGMENT_SHADER, fs)
        if (!v || !f) return null
        var p = gl.createProgram()
        gl.attachShader(p, v)
        gl.attachShader(p, f)
        gl.linkProgram(p)
        gl.deleteShader(v)
        gl.deleteShader(f)
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            console.warn("glass link:", gl.getProgramInfoLog(p))
            return null
        }
        return p
    }

    /* ------------------------------------------------------------------ */
    /* точка входа                                                         */
    /* ------------------------------------------------------------------ */

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} [opts]
     *   text        строка, перевод строки делит на строки
     *   background  цвет, которым грунтуется подложка (см. ниже)
     *   textColor   цвет надписи
     *   fontFamily  семейство
     *   fontWeight  насыщенность
     *   size        0..100, доля кадра по вертикали
     *   depth       0..100, толщина трубы тора
     *   speed       0..100, скорость вращения
     *   chromatic   0..100, разбег каналов
     *   frost       0..100, матовость
     *   tint        цвет стекла
     * @returns {{destroy: function}|null}
     */
    function initGlass(canvas, opts) {
        opts = opts || {}

        var cfg = {
            text: opts.text != null ? opts.text : "СВОБОДА\nСЛОВА",
            background: opts.background || "#000000",
            textColor: opts.textColor || "#FFFFFF",
            fontFamily: opts.fontFamily || "Inter, system-ui, sans-serif",
            fontWeight: opts.fontWeight || 700,
            fontSize: opts.fontSize || 120,
            lineHeight: opts.lineHeight || 1.1,
            letterSpacing: opts.letterSpacing || 0,
            size: opts.size != null ? opts.size : 60,
            depth: opts.depth != null ? opts.depth : 32,
            speed: opts.speed != null ? opts.speed : 36,
            direction: opts.direction === "Counterclockwise" ? -1 : 1,
            chromatic: opts.chromatic != null ? opts.chromatic : 79,
            frost: opts.frost != null ? opts.frost : 50,
            tint: opts.tint || "#FFFFFF"
        }

        var glOpts = { antialias: false, alpha: true, premultipliedAlpha: true }
        var gl = canvas.getContext("webgl2", glOpts) || canvas.getContext("webgl", glOpts)
        if (!gl) return null

        // На тачскрине шейдер режется вдвое по обеим тяжёлым осям, а плотность
        // пикселей прижимается к 1. Разница на глаз почти не читается, а
        // разница в нагреве телефона — читается очень хорошо.
        var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches
        var samples = coarse ? 10 : 24
        var steps = coarse ? 40 : 80
        var maxDpr = coarse ? 1 : 2

        var plateProg = link(gl, FULLSCREEN_VS, PLATE_FS)
        var glassProg = link(gl, FULLSCREEN_VS, glassFS(samples, steps))
        if (!plateProg || !glassProg) return null

        var uPlatePass = {
            plate: gl.getUniformLocation(plateProg, "uPlate"),
            fit: gl.getUniformLocation(plateProg, "uPlateFit"),
            res: gl.getUniformLocation(plateProg, "uRes")
        }
        var u = {
            res: gl.getUniformLocation(glassProg, "uRes"),
            aspect: gl.getUniformLocation(glassProg, "uAspect"),
            tanHalf: gl.getUniformLocation(glassProg, "uTanHalf"),
            plate: gl.getUniformLocation(glassProg, "uPlate"),
            plateFit: gl.getUniformLocation(glassProg, "uPlateFit"),
            hasPlate: gl.getUniformLocation(glassProg, "uHasPlate"),
            env: gl.getUniformLocation(glassProg, "uEnv"),
            rot: gl.getUniformLocation(glassProg, "uRot"),
            rotT: gl.getUniformLocation(glassProg, "uRotT"),
            center: gl.getUniformLocation(glassProg, "uCenter"),
            scale: gl.getUniformLocation(glassProg, "uScale"),
            boundR: gl.getUniformLocation(glassProg, "uBoundR"),
            torusTube: gl.getUniformLocation(glassProg, "uTorusTube"),
            disp: gl.getUniformLocation(glassProg, "uDisp"),
            frost: gl.getUniformLocation(glassProg, "uFrost"),
            tint: gl.getUniformLocation(glassProg, "uTint")
        }
        var aPlatePos = gl.getAttribLocation(plateProg, "aPos")
        var aGlassPos = gl.getAttribLocation(glassProg, "aPos")

        var quadBuf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)

        function makeTex(wrap) {
            var t = gl.createTexture()
            gl.bindTexture(gl.TEXTURE_2D, t)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
                gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
            return t
        }
        var plateTex = makeTex(gl.CLAMP_TO_EDGE)
        // по долготе equirect заворачивается; 1024 — степень двойки, REPEAT легален
        var envTex = makeTex(gl.REPEAT)

        var envCanvas = buildEnvCanvas()
        if (envCanvas) {
            gl.bindTexture(gl.TEXTURE_2D, envTex)
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, envCanvas)
        }

        var vw = 1, vh = 1, dprCur = 1
        var plateReady = false
        var needPlate = true
        var fontsWaited = false

        /*
         * Подложка с надписью. Печём в размер буфера холста, поэтому вписывание
         * по cover получается тождественным — текст на подложке фиксированной
         * пропорции обрезало бы или тянуло.
         *
         * Подложка ГРУНТУЕТСЯ цветом фона до того, как ляжет текст. Если
         * оставить её прозрачной, стеклу нечего преломлять: bgAlpha всюду вне
         * букв равен нулю, шейдер уходит в ветку прозрачного стекла и бублик
         * выходит плоским молоком без разбега каналов.
         */
        function bakePlate() {
            var w = Math.max(2, vw), h = Math.max(2, vh)
            var c = document.createElement("canvas")
            c.width = w
            c.height = h
            var ctx = c.getContext("2d")
            if (!ctx) return

            // 120px задумывались под широкий экран; на телефоне «СВОБОДА» в
            // такой кегль просто не влезает, поэтому кегль привязан к ширине
            var cssW = w / dprCur
            var fontPx = Math.min(cfg.fontSize, cssW / 6.2) * dprCur
            var lineH = cfg.lineHeight * fontPx

            ctx.clearRect(0, 0, w, h)
            ctx.fillStyle = cfg.background
            ctx.fillRect(0, 0, w, h)
            ctx.font = "normal " + cfg.fontWeight + " " + fontPx + "px " + cfg.fontFamily
            ctx.textAlign = "center"
            ctx.textBaseline = "middle"
            ctx.fillStyle = cfg.textColor
            if ("letterSpacing" in ctx) ctx.letterSpacing = cfg.letterSpacing * dprCur + "px"

            var lines = String(cfg.text).split("\n")
            var top = h / 2 - ((lines.length - 1) * lineH) / 2
            for (var i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], w / 2, top + i * lineH)
            }

            gl.bindTexture(gl.TEXTURE_2D, plateTex)
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c)
            plateReady = true

            /* Первая выпечка попадает на момент, когда веб-шрифт ещё грузится,
             * молча берёт запасное семейство и больше никогда не пересчитывается.
             * Поэтому один раз ждём готовности шрифтов. Флаг обязателен:
             * промис резолвится на каждый вызов, и без него будет цикл. */
            if (!fontsWaited && document.fonts) {
                fontsWaited = true
                document.fonts.ready.then(function () { needPlate = true })
            }
        }

        function resize() {
            var dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
            var cw = canvas.clientWidth || 1
            var ch = canvas.clientHeight || 1
            var w = Math.max(1, Math.round(cw * dpr))
            var h = Math.max(1, Math.round(ch * dpr))
            if (w === vw && h === vh && dpr === dprCur) return
            dprCur = dpr
            vw = w
            vh = h
            canvas.width = w
            canvas.height = h
            // подложка испечена в размер буфера — смена размера её обнуляет
            needPlate = true
        }

        var ro = new ResizeObserver(resize)
        ro.observe(canvas)
        resize()

        /* ---- взаимодействие ---- */

        var baseYaw = 0, basePitch = 0
        var tiltX = 0, tiltY = 0
        var targetTiltX = 0, targetTiltY = 0
        var dragging = false
        var lastX = 0, lastY = 0

        function onPointerMove(e) {
            if (dragging) {
                // пока тянут — вращение принадлежит перетаскиванию, цель
                // наклона заморожена, иначе оба эффекта складываются
                baseYaw += (e.clientX - lastX) * DRAG_GAIN
                basePitch += (e.clientY - lastY) * DRAG_GAIN
                basePitch = Math.max(-1.4, Math.min(1.4, basePitch))
                lastX = e.clientX
                lastY = e.clientY
                return
            }
            var r = canvas.getBoundingClientRect()
            targetTiltX = (((e.clientX - r.left) / Math.max(r.width, 1)) * 2 - 1) * TILT_RANGE
            targetTiltY = (-((e.clientY - r.top) / Math.max(r.height, 1)) * 2 + 1) * TILT_RANGE
        }
        function onPointerDown(e) {
            dragging = true
            lastX = e.clientX
            lastY = e.clientY
        }
        function onPointerUp() { dragging = false }
        function onLeave() {
            if (!dragging) { targetTiltX = 0; targetTiltY = 0 }
        }

        canvas.addEventListener("pointerdown", onPointerDown)
        canvas.addEventListener("pointerleave", onLeave)
        // отпускание слушаем на окне: палец может уйти за холст, не отпустив
        window.addEventListener("pointermove", onPointerMove)
        window.addEventListener("pointerup", onPointerUp)
        window.addEventListener("pointercancel", onPointerUp)

        /* ---- цикл ---- */

        gl.disable(gl.DEPTH_TEST)
        gl.enable(gl.BLEND)
        // шейдер отдаёт прямую альфу, буфер рисования премультиплицирован —
        // раздельные множители держат альфа-канал честным
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.clearColor(0, 0, 0, 0)

        var raf = 0
        var prev = performance.now()
        var elapsed = 0
        var visible = true
        var alive = true

        // холст, уехавший за пределы экрана, продолжал бы жечь батарею
        var io = new IntersectionObserver(function (entries) {
            visible = entries[0].isIntersecting
            if (visible && !raf && alive) {
                prev = performance.now()
                raf = requestAnimationFrame(frame)
            }
        }, { threshold: 0 })
        io.observe(canvas)

        function onVisibility() {
            if (document.hidden) return
            prev = performance.now()
        }
        document.addEventListener("visibilitychange", onVisibility)

        function frame(now) {
            if (!alive) return
            if (!visible || document.hidden) { raf = 0; return }
            raf = requestAnimationFrame(frame)

            var dt = Math.min((now - prev) / 1000, 0.05)
            prev = now
            elapsed += dt

            if (needPlate) { needPlate = false; bakePlate() }

            // экспоненциальное приближение к цели, ~0.6 с до посадки
            var k = 1 - Math.exp(-TILT_RATE * dt)
            tiltX += (targetTiltX - tiltX) * k
            tiltY += (targetTiltY - tiltY) * k

            var spin = (cfg.speed / 50) * cfg.direction
            baseYaw += spin * SPIN_YAW * dt
            basePitch += spin * SPIN_PITCH * dt

            var yaw = baseYaw + tiltX
            var pitch = Math.max(-1.45, Math.min(1.45, basePitch - tiltY))
            var rot = rotYX(yaw, pitch)
            var rotT = transpose3(rot)

            var halfFrame = CAM_DIST * Math.tan(FOV / 2)
            var targetHalf = Math.max(0.02, cfg.size / 100) * halfFrame

            var nativeDepth = Math.max(0, cfg.depth / 100)
            var torusTube = Math.max(0.02, nativeDepth * 0.5)
            var refHalf = 0.8 + torusTube
            var boundR = refHalf
            var scale = targetHalf / refHalf
            var floatY = Math.sin(elapsed * 2) * IDLE_FLOAT

            var screenAspect = vw / vh
            // подложка печётся в размер экрана, так что вписывание тождественно
            var fitX = 1, fitY = 1
            var hasPlate = plateReady ? 1 : 0

            gl.viewport(0, 0, vw, vh)
            gl.clear(gl.COLOR_BUFFER_BIT)
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)

            // проход 1 — подложка
            if (hasPlate) {
                gl.useProgram(plateProg)
                gl.activeTexture(gl.TEXTURE0)
                gl.bindTexture(gl.TEXTURE_2D, plateTex)
                gl.uniform1i(uPlatePass.plate, 0)
                gl.uniform2f(uPlatePass.fit, fitX, fitY)
                gl.uniform2f(uPlatePass.res, vw, vh)
                gl.enableVertexAttribArray(aPlatePos)
                gl.vertexAttribPointer(aPlatePos, 2, gl.FLOAT, false, 0, 0)
                gl.drawArrays(gl.TRIANGLES, 0, 3)
            }

            // проход 2 — тело стекла
            gl.useProgram(glassProg)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, plateTex)
            gl.uniform1i(u.plate, 0)
            gl.activeTexture(gl.TEXTURE1)
            gl.bindTexture(gl.TEXTURE_2D, envTex)
            gl.uniform1i(u.env, 1)

            gl.uniform2f(u.res, vw, vh)
            gl.uniform1f(u.aspect, screenAspect)
            gl.uniform1f(u.tanHalf, Math.tan(FOV / 2))
            gl.uniform2f(u.plateFit, fitX, fitY)
            gl.uniform1f(u.hasPlate, hasPlate)

            gl.uniformMatrix3fv(u.rot, false, rot)
            gl.uniformMatrix3fv(u.rotT, false, rotT)
            gl.uniform3f(u.center, 0, floatY, -CAM_DIST)
            gl.uniform1f(u.scale, scale)
            gl.uniform1f(u.boundR, boundR)
            gl.uniform1f(u.torusTube, torusTube)

            gl.uniform1f(u.disp, cfg.chromatic / 1000)
            gl.uniform1f(u.frost, cfg.frost / 100)
            var tint = parseColor(cfg.tint, [1, 1, 1])
            gl.uniform3f(u.tint, tint[0], tint[1], tint[2])

            gl.enableVertexAttribArray(aGlassPos)
            gl.vertexAttribPointer(aGlassPos, 2, gl.FLOAT, false, 0, 0)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
        raf = requestAnimationFrame(frame)

        return {
            /** Меняет надпись на лету; подложка перепечётся в следующем кадре. */
            setText: function (text) {
                cfg.text = text
                needPlate = true
            },
            destroy: function () {
                alive = false
                cancelAnimationFrame(raf)
                ro.disconnect()
                io.disconnect()
                document.removeEventListener("visibilitychange", onVisibility)
                canvas.removeEventListener("pointerdown", onPointerDown)
                canvas.removeEventListener("pointerleave", onLeave)
                window.removeEventListener("pointermove", onPointerMove)
                window.removeEventListener("pointerup", onPointerUp)
                window.removeEventListener("pointercancel", onPointerUp)
            }
        }
    }

    window.initGlass = initGlass
})()
