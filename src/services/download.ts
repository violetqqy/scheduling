export function download(data: BlobPart, name: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([data], { type })), anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}
