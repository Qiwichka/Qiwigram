/*
 * dither.js — дизерный вихрь для страницы «Как работает шифрование».
 *
 * Порт компонента Dither Effect 2 (Originkit / paper-shaders) на голый WebGL2
 * без React. Что выкинуто и почему:
 *
 *   - Вертексный шейдер оригинала считает шесть наборов varying-координат.
 *     Дизерный фрагментный шейдер не объявляет НИ ОДНОГО varying — он целиком
 *     работает от gl_FragCoord. Значит вся эта арифметика уходила в никуда,
 *     и здесь остался обычный полноэкранный треугольник.
 *   - Шесть остальных фигур (simplex, warp, dots, wave, ripple, sphere)
 *     вместе с симплекс-шумом и двумя хеш-функциями: нужен только вихрь.
 *   - Матрицы Байера 2x2 и 8x8 и случайный дизер: используем 4x4.
 *   - Ротация, смещения и точка отсчёта: все нули и центр, так что
 *     соответствующие члены сократились. Масштаб и размер пикселя остались
 *     живыми параметрами.
 *
 * Сам рисунок и способ дизеринга — оригинальные, терм в терм.
 */

(function () {
    "use strict"

    var VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`

    var FS = `#version 300 es
precision mediump float;

uniform float u_time;
uniform vec2  u_resolution;
uniform float u_pixelRatio;
uniform float u_scale;
uniform float u_pxSize;
uniform vec4  u_colorBack;
uniform vec4  u_colorFront;

out vec4 fragColor;

#define TWO_PI 6.28318530718

/* Матрица Байера 4x4 — упорядоченный дизеринг: вместо честного полутона
   пиксель либо горит, либо нет, а порог зависит от его места в сетке.
   Отсюда и характерный «пиксельный» вид. */
const int bayer4x4[16] = int[16](
    0,  8,  2, 10,
   12,  4, 14,  6,
    3, 11,  1,  9,
   15,  7, 13,  5
);

float bayer(vec2 uv) {
    ivec2 p = ivec2(fract(uv / 4.0) * 4.0);
    return float(bayer4x4[p.y * 4 + p.x]) / 16.0;
}

void main() {
    float t = 0.5 * u_time;

    // Крупный «пиксель»: координата загоняется в сетку до всех расчётов
    float pxSize = u_pxSize * u_pixelRatio;
    vec2 pxUV = (gl_FragCoord.xy - 0.5 * u_resolution) / pxSize;
    vec2 pixelized = (floor(pxUV) + 0.5) * pxSize;
    vec2 uv = pixelized / u_resolution;

    /* Вписывание по cover: короткая сторона тянется до длинной, поэтому
       рисунок не сплющивается на широком экране. Смещения и поворот в
       оригинале здесь нулевые, их члены сократились. */
    float box = max(u_resolution.x, u_resolution.y);
    uv *= u_resolution / vec2(box);
    uv /= u_scale;

    // Вихрь
    float l = length(uv);
    float angle = 6.0 * atan(uv.y, uv.x) + 4.0 * t;
    float twist = 1.2;
    float offset = 1.0 / pow(max(l, 1e-6), twist) + angle / TWO_PI;
    float mid = smoothstep(0.0, 1.0, pow(l, twist));
    float shape = mix(0.0, fract(offset), mid);

    float res = step(0.5, shape + bayer(pxUV) - 0.5);

    vec3 fg = u_colorFront.rgb * u_colorFront.a;
    vec3 bg = u_colorBack.rgb * u_colorBack.a;

    vec3 color = fg * res;
    float opacity = u_colorFront.a * res;
    color += bg * (1.0 - opacity);
    opacity += u_colorBack.a * (1.0 - opacity);

    fragColor = vec4(color, opacity);
}`

    function parseColor(s, fallback) {
        if (typeof s !== "string") return fallback
        var h = s.trim().replace(/^#/, "")
        if (h.length === 3) h = h.split("").map(function (c) { return c + c }).join("")
        if (h.length === 6) h += "ff"
        if (h.length !== 8) return fallback
        var v = [0, 2, 4, 6].map(function (i) { return parseInt(h.slice(i, i + 2), 16) / 255 })
        return v.some(isNaN) ? fallback : v
    }

    function compile(gl, type, src) {
        var s = gl.createShader(type)
        gl.shaderSource(s, src)
        gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.warn("dither:", gl.getShaderInfoLog(s))
            return null
        }
        return s
    }

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} [opts] background, color, size (10..200), speed (1..100), scale (1..200)
     * @returns {{destroy: function}|null} null — WebGL2 недоступен
     */
    function initDither(canvas, opts) {
        opts = opts || {}
        var gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: true })
        if (!gl) return null

        var vs = compile(gl, gl.VERTEX_SHADER, VS)
        var fs = compile(gl, gl.FRAGMENT_SHADER, FS)
        if (!vs || !fs) return null

        var prog = gl.createProgram()
        gl.attachShader(prog, vs)
        gl.attachShader(prog, fs)
        gl.linkProgram(prog)
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.warn("dither link:", gl.getProgramInfoLog(prog))
            return null
        }
        gl.deleteShader(vs)
        gl.deleteShader(fs)

        var buf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

        var u = {
            time: gl.getUniformLocation(prog, "u_time"),
            res: gl.getUniformLocation(prog, "u_resolution"),
            ratio: gl.getUniformLocation(prog, "u_pixelRatio"),
            scale: gl.getUniformLocation(prog, "u_scale"),
            px: gl.getUniformLocation(prog, "u_pxSize"),
            back: gl.getUniformLocation(prog, "u_colorBack"),
            front: gl.getUniformLocation(prog, "u_colorFront")
        }

        // Те же деления, что делал компонент, разворачивая значения панели
        var cfg = {
            back: parseColor(opts.background, [0, 0, 0, 1]),
            front: parseColor(opts.color, [0, 1, 0.75, 1]),
            px: (opts.size != null ? opts.size : 34) / 10,
            speed: (opts.speed != null ? opts.speed : 56) / 20,
            scale: (opts.scale != null ? opts.scale : 32) / 100
        }

        // На телефоне считать это в тройной плотности незачем: рисунок и так
        // нарочито крупнопиксельный, разницы не видно, а нагрев заметен
        var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches
        var maxDpr = coarse ? 1 : 2

        var vw = 1, vh = 1, ratio = 1
        function resize() {
            var dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
            var w = Math.max(1, Math.round((canvas.clientWidth || 1) * dpr))
            var h = Math.max(1, Math.round((canvas.clientHeight || 1) * dpr))
            if (w === vw && h === vh) return
            vw = w; vh = h; ratio = dpr
            canvas.width = w
            canvas.height = h
            gl.viewport(0, 0, w, h)
        }
        var ro = new ResizeObserver(resize)
        ro.observe(canvas)
        resize()

        gl.clearColor(0, 0, 0, 0)

        var raf = 0, prev = performance.now(), frame = 0, alive = true, visible = true

        var io = new IntersectionObserver(function (e) {
            visible = e[0].isIntersecting
            if (visible && !raf && alive) { prev = performance.now(); raf = requestAnimationFrame(draw) }
        }, { threshold: 0 })
        io.observe(canvas)

        function draw(now) {
            if (!alive) return
            if (!visible || document.hidden) { raf = 0; return }
            raf = requestAnimationFrame(draw)

            frame += Math.min(now - prev, 50) * cfg.speed
            prev = now

            gl.clear(gl.COLOR_BUFFER_BIT)
            gl.useProgram(prog)
            gl.uniform1f(u.time, frame * 0.001)
            gl.uniform2f(u.res, vw, vh)
            gl.uniform1f(u.ratio, ratio)
            gl.uniform1f(u.scale, cfg.scale)
            gl.uniform1f(u.px, cfg.px)
            gl.uniform4fv(u.back, cfg.back)
            gl.uniform4fv(u.front, cfg.front)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
        raf = requestAnimationFrame(draw)

        function onVisibility() { if (!document.hidden) prev = performance.now() }
        document.addEventListener("visibilitychange", onVisibility)

        return {
            destroy: function () {
                alive = false
                cancelAnimationFrame(raf)
                ro.disconnect()
                io.disconnect()
                document.removeEventListener("visibilitychange", onVisibility)
            }
        }
    }

    window.initDither = initDither
})()
