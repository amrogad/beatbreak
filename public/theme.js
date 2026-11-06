try {
  var saved = JSON.parse(localStorage.getItem('pulsegrid:settings:v1') || '{}')
  if (saved.theme === 'mono') document.documentElement.dataset.theme = 'mono'
} catch (e) {}
