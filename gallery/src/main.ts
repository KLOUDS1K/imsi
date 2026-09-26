/** Route-level entry point: the archive stays lean; Studio loads only on /studio. */
const studio = window.location.pathname.replace(/\/+$/, '') === '/studio'

const fail = (error: unknown) => {
  console.error(error)
  document.documentElement.classList.add('app-ready')
  document.body.textContent = 'The page could not start. Please reload.'
}

if (studio) void import('./app/studio').then((module) => module.bootStudio()).catch(fail)
else void import('./app/main').catch(fail)
