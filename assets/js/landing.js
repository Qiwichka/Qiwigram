/* landing.js — сборка главной страницы */

(function () {
    "use strict"

    /* --------------------------- стеклянный фон --------------------------- */

    var canvas = document.getElementById("glass")
    if (canvas && typeof window.initGlass === "function") {
        var glass = window.initGlass(canvas, {
            text: "СВОБОДА\nСЛОВА",
            background: "#000000",
            textColor: "#FFFFFF",
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 800,
            fontSize: 130,
            lineHeight: 1.02,
            letterSpacing: -3,
            size: 60,
            depth: 32,
            speed: 36,
            direction: "Clockwise",
            chromatic: 79,
            frost: 50,
            tint: "#FFFFFF"
        })

        /* WebGL может не подняться: старый драйвер, отключённое аппаратное
         * ускорение, режим экономии на телефоне. Тогда холст остаётся пустым
         * чёрным прямоугольником и надписи на экране нет вообще — поэтому
         * подменяем его обычным текстовым заголовком. */
        if (!glass) {
            canvas.remove()
            var fallback = document.createElement("div")
            fallback.className = "hero__fallback"
            fallback.innerHTML = "<span>СВОБОДА</span><span>СЛОВА</span>"
            document.querySelector(".hero").prepend(fallback)
            document.body.classList.add("no-webgl")
        }
    }

    /* ---------------------- появление блоков при скролле ---------------------- */

    var revealables = document.querySelectorAll(".reveal")

    if (!("IntersectionObserver" in window)) {
        // без наблюдателя показываем всё сразу, иначе страница будет пустой
        revealables.forEach(function (el) { el.classList.add("is-visible") })
    } else {
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return
                entry.target.classList.add("is-visible")
                // блок появляется один раз и больше не мигает при обратном скролле
                io.unobserve(entry.target)
            })
        }, { threshold: 0.15, rootMargin: "0px 0px -60px 0px" })

        revealables.forEach(function (el) { io.observe(el) })
    }

    /* ------------------------------ офлайн ------------------------------ */

    if ("serviceWorker" in navigator) {
        window.addEventListener("load", function () {
            navigator.serviceWorker.register("sw.js").catch(function (err) {
                console.warn("service worker:", err)
            })
        })
    }
})()
