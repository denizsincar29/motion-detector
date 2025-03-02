function speak(text, priority) {
    var el = document.createElement('div')
    var id = 'speak-' + Date.now()
    el.setAttribute('id', id)
    el.setAttribute('aria-live', priority || 'polite')
    el.classList.add('visually-hidden')
    document.body.appendChild(el)

    window.setTimeout(function () {
        document.getElementById(id).innerHTML = text
    }, 100)

    window.setTimeout(function () {
        document.body.removeChild(document.getElementById(id))
    }, 1000)
}

