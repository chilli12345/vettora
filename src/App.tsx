import { useEffect, useMemo, useState } from 'react'
import vettoraLogo from './assets/vettora-logo.png'
import './App.css'

type Finding = { severity: 'High' | 'Medium' | 'Info'; title: string; detail: string; suggestion: string }
type Upload = { name: string; url: string; file: File }
type FlaggedClaim = { id: string; text: string; reasons: string[]; keywords: string[] }
type ClaimEvidence = { files: string[]; status: 'pending' | 'verified' | 'needs-proof' }
type ReviewStatus = 'not-checked' | 'needs-evidence' | 'needs-correction' | 'approved'
type ReviewRevision = { version: number; copy: string; status: ReviewStatus; findings: Finding[]; recordedAt: string }
type AIFlaggedClaim = { statement: string; reason: string; keywords: string[]; evidence_required: boolean; suggested_correction: string }
type AIReview = { extracted_ad_text: string; flagged_claims: AIFlaggedClaim[]; findings: Finding[]; overall_assessment: 'evidence_needed' | 'correction_needed' | 'no_obvious_issues' }
type PastReview = { id: string; brand: string; product: string; reviewedAt: string; status: string; findingCount: number }

const initialHeadline = 'Try GlowShield Sunscreen SPF 50!'
const initialAdClaims = 'It cures acne overnight and gives you 100% sun protection.'
const initialAdDescription = 'Get 50% off today.'
const steps = ['Product profile', 'Evidence & claims', 'Advertisement', 'Review findings']
const claimSignals: Array<{ reason: string; pattern: RegExp }> = [
  { reason: 'Proof or clinical testing language', pattern: /\b(?:clinically|scientifically)\s+(?:proven|tested|shown|validated)\b|\bproven\s+to\b|\b(?:stud(?:y|ies)|research|tests?)\s+(?:proves?|shows?|showed|confirms?)\b/i },
  { reason: 'Medical or specialist endorsement', pattern: /\b(?:doctor|physician|dermatologist)s?\s+(?:recommended|approved|endorsed|tested)\b|\brecommended\s+by\s+(?:doctors?|physicians?|dermatologists?)\b/i },
  { reason: 'Guarantee or absolute assurance', pattern: /\bguarantee[ds]?\b|\b100%\b|\brisk[- ]free\b|\bno\s+side\s+effects\b|\bnever\s+fails?\b|\bpermanent(?:ly)?\b/i },
  { reason: 'Medical outcome claim', pattern: /\b(?:cures?|treats?|heals?|prevents?)\b/i },
  { reason: 'Safety assurance', pattern: /\bsafe\s+for\s+(?:everyone|all|children|babies|sensitive\s+skin)\b|\bnon[- ]toxic\b/i },
  { reason: 'Specific result or timeframe', pattern: /\b(?:instant(?:ly)?|overnight|within\s+\d+\s+days?|in\s+\d+\s+hours?)\b/i },
]

function detectEvidenceClaims(description: string, idPrefix = 'claim'): FlaggedClaim[] {
  return description.split(/(?<=[.!?])\s+|\n+/).map(line => line.trim()).filter(Boolean).flatMap(line => {
    const matches = claimSignals.filter(signal => signal.pattern.test(line))
    if (!matches.length) return []
    const keywords = [...new Set(matches.flatMap(signal => line.match(new RegExp(signal.pattern.source, 'ig')) ?? []))]
    return [{ id: `${idPrefix}-${line.toLowerCase()}`, text: line, reasons: matches.map(match => match.reason), keywords }]
  })
}

function normalizeClaim(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function mergeClaims(claims: FlaggedClaim[]) {
  const merged = new Map<string, FlaggedClaim>()
  claims.forEach(claim => {
    const key = normalizeClaim(claim.text)
    const previous = merged.get(key)
    merged.set(key, previous ? {
      ...previous,
      reasons: [...new Set([...previous.reasons, ...claim.reasons])],
      keywords: [...new Set([...previous.keywords, ...claim.keywords])],
    } : claim)
  })
  return [...merged.values()]
}

function mergeFindings(...groups: Finding[][]) {
  const merged = new Map<string, Finding>()
  groups.flat().forEach(finding => merged.set(`${finding.title}-${finding.detail}`, finding))
  return [...merged.values()]
}

function useImageUploads() {
  const [files, setFiles] = useState<Upload[]>([])
  const add = (list: FileList | null) => {
    if (!list) return
    const next = Array.from(list).filter(file => file.type.startsWith('image/')).map(file => ({ name: file.name, url: URL.createObjectURL(file), file }))
    setFiles(current => [...current, ...next])
  }
  const clear = () => { files.forEach(file => URL.revokeObjectURL(file.url)); setFiles([]) }
  return { files, add, clear }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(`Could not read ${file.name}.`))
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.readAsDataURL(file)
  })
}

function reviewContent(product: string, description: string, ingredients: string, claims: string, restrictions: string, copy: string): Finding[] {
  const results: Finding[] = []
  const approvedSpf = description.match(/approved\s+spf\s*:?\s*(\d+)/i)?.[1] ?? product.match(/spf\s*(\d+)/i)?.[1]
  const adSpf = copy.match(/\bspf\s*(\d+)/i)?.[1]
  if (approvedSpf && adSpf && approvedSpf !== adSpf) results.push({ severity: 'High', title: 'SPF value mismatch', detail: `The advertisement says SPF ${adSpf}; the product reference says SPF ${approvedSpf}.`, suggestion: `Confirm the current label and use SPF ${approvedSpf} if that is the approved value.` })
  const approvedDiscount = description.match(/approved\s+discount\s*:?\s*(\d+)%/i)?.[1]
  const adDiscount = copy.match(/\b(\d+)%\s*off\b/i)?.[1]
  if (approvedDiscount && adDiscount && approvedDiscount !== adDiscount) results.push({ severity: 'High', title: 'Discount does not match the approved offer', detail: `The ad offers ${adDiscount}% off; the product reference lists ${approvedDiscount}%.`, suggestion: 'Verify the live promotion and correct the offer before publishing.' })
  if (/\bcures?\b|\bguaranteed to cure\b|\bpermanently eliminates?\b/i.test(copy) && /cure|restricted|prohibited/i.test(restrictions)) results.push({ severity: 'High', title: 'Restricted product claim', detail: 'The advertisement uses cure language that the supplied restrictions prohibit.', suggestion: 'Remove the cure wording and use an approved, evidence-supported benefit.' })
  if (/\b100%\s*(sun |uv )?protection\b/i.test(copy)) results.push({ severity: 'Medium', title: 'Absolute protection claim needs proof', detail: 'The ad promises 100% protection. No automated check can establish that this claim is substantiated.', suggestion: 'Request suitable test evidence and human approval, or use the approved wording.' })
  if (/\bovernight\b|\bin \d+\s*hours?\b/i.test(copy) && !/overnight|\d+\s*hours?/i.test(`${description} ${claims}`)) results.push({ severity: 'Medium', title: 'Time-based claim needs evidence', detail: 'The ad promises a result by a specific time that is not present in the submitted product details or claims.', suggestion: 'Request supporting evidence and reviewer approval, or remove the timeframe.' })
  if (!ingredients.trim()) results.push({ severity: 'Medium', title: 'Ingredient information is missing', detail: 'No ingredient list was provided for this review.', suggestion: 'Add the current product ingredient list and check relevant ad claims against it.' })
  if (!results.length) results.push({ severity: 'Info', title: 'No obvious mismatch detected', detail: 'The basic text checks found no configured issue. This does not establish that the advertisement is accurate or compliant.', suggestion: 'Have a reviewer compare every factual claim with current product information and evidence.' })
  return results
}

function App() {
  const [activeTab, setActiveTab] = useState<'home' | 'review' | 'history' | 'guidelines'>('home')
  const [pastReviews, setPastReviews] = useState<PastReview[]>(() => {
    try { return JSON.parse(localStorage.getItem('vettora-past-reviews') || '[]') as PastReview[] } catch { return [] }
  })
  const [authenticated, setAuthenticated] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [authMessage, setAuthMessage] = useState('')
  const [loginId, setLoginId] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [signupEmail, setSignupEmail] = useState('')
  const [signupPassword, setSignupPassword] = useState('')
  const [companies, setCompanies] = useState('')
  const accountValue = (authMode === 'signup' ? signupEmail : loginId).trim()
  const accountEmail = accountValue.includes('@') ? accountValue : ''
  const accountName = accountEmail ? accountEmail.split('@')[0].replace(/[._-]+/g, ' ') : accountValue || 'Guest'
  const accountInitials = accountName.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('')
  const [step, setStep] = useState(0)
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }) }, [step])
  const [brand, setBrand] = useState('GlowShield')
  const [product, setProduct] = useState('GlowShield Sunscreen SPF 30')
  const [description, setDescription] = useState('Broad-spectrum sunscreen with zinc oxide and aloe vera.\nClinically proven to help protect skin from UV rays.\nDermatologist recommended.\nApproved SPF: 30\nApproved discount: 10%')
  const [ingredients, setIngredients] = useState('Zinc oxide, aloe vera')
  const packaging = useImageUploads()
  const [restrictions, setRestrictions] = useState('Do not claim to cure acne or guarantee 100% sun protection.')
  const [claimEvidence, setClaimEvidence] = useState<Record<string, ClaimEvidence>>({})
  const adImages = useImageUploads()
  const revisionImages = useImageUploads()
  const [adHeadline, setAdHeadline] = useState(initialHeadline)
  const [adClaims, setAdClaims] = useState(initialAdClaims)
  const [adDescription, setAdDescription] = useState(initialAdDescription)
  const [suggestedCopy, setSuggestedCopy] = useState('')
  const [additionalClaims, setAdditionalClaims] = useState<FlaggedClaim[]>([])
  const [returnToAdReview, setReturnToAdReview] = useState(false)
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>('not-checked')
  const [revisionHistory, setRevisionHistory] = useState<ReviewRevision[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [aiFlaggedClaims, setAiFlaggedClaims] = useState<FlaggedClaim[]>([])
  const [aiReviewedCopy, setAiReviewedCopy] = useState('')
  const [extractedAdText, setExtractedAdText] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [checked, setChecked] = useState(false)
  const highCount = findings.filter(item => item.severity === 'High').length
  const mediumCount = findings.filter(item => item.severity === 'Medium').length
  const profileComplete = useMemo(() => Boolean(brand.trim() && product.trim() && description.trim()), [brand, product, description])
  const flaggedClaims = detectEvidenceClaims(description, 'profile')
  const evidenceClaims = [...flaggedClaims, ...additionalClaims]
  const claims = evidenceClaims.map(claim => claim.text).join('\n')
  const ad = [adHeadline, adClaims, adDescription].map(value => value.trim()).filter(Boolean).join('\n')
  const proposedAd = suggestedCopy.trim() || ad
  const previewClaims = mergeClaims([...detectEvidenceClaims(proposedAd, 'advertisement'), ...(aiReviewedCopy === proposedAd ? aiFlaggedClaims : [])])
  const findingsFor = (copy: string) => {
    const detected = detectEvidenceClaims(copy, 'advertisement')
    const verifiedAdClaims = detected.filter(adClaim => {
      const normalized = adClaim.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      const match = evidenceClaims.find(claim => claim.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === normalized)
      return match && claimEvidence[match.id]?.status === 'verified'
    })
    return reviewContent(product, description, ingredients, claims, restrictions, copy).filter(finding =>
      !(finding.title === 'Absolute protection claim needs verification' && verifiedAdClaims.some(claim => /\b100%\s*(sun |uv )?protection\b/i.test(claim.text))),
    )
  }
  const previewFindings = findingsFor(proposedAd)
  const runReview = () => {
    const completedFindings = aiReviewedCopy === proposedAd && !aiError ? mergeFindings(findings, findingsFor(proposedAd)) : findingsFor(proposedAd)
    setFindings(completedFindings)
    setChecked(true)
    setStep(3)
    const entry: PastReview = { id: `${Date.now()}`, brand, product, reviewedAt: new Date().toISOString(), status: reviewStatus === 'approved' ? 'Verified' : reviewStatus === 'needs-evidence' ? 'Evidence requested' : reviewStatus === 'needs-correction' ? 'Corrections needed' : 'Submitted for review', findingCount: completedFindings.length }
    setPastReviews(current => {
      const next = [entry, ...current]
      try { localStorage.setItem('vettora-past-reviews', JSON.stringify(next)) } catch { /* Browser storage may be unavailable. */ }
      return next
    })
  }
  const exportReview = () => window.print()
  const reverify = async () => {
    setAiLoading(true)
    setAiError('')
    try {
      const images = await Promise.all([...adImages.files, ...revisionImages.files].map(async image => ({ name: image.name, dataUrl: await fileToDataUrl(image.file) })))
      const response = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand,
          product,
          description,
          ingredients,
          restrictions,
          headline: adHeadline,
          adClaims,
          adDescription,
          proposedCopy: proposedAd,
          images,
          evidenceStatuses: evidenceClaims.map(claim => ({ claim: claim.text, status: claimEvidence[claim.id]?.status ?? 'pending', fileNames: claimEvidence[claim.id]?.files ?? [] })),
        }),
      })
      const result = await response.json() as AIReview & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Vettora could not complete the AI review.')

      const modelClaims: FlaggedClaim[] = result.flagged_claims.map((claim, index) => ({
        id: `ai-${normalizeClaim(claim.statement) || index}`,
        text: claim.statement,
        reasons: [claim.reason],
        keywords: claim.keywords,
      }))
      setAiFlaggedClaims(modelClaims)
      setAiReviewedCopy(proposedAd)
      setExtractedAdText(result.extracted_ad_text)

      const allAdClaims = mergeClaims([
        ...detectEvidenceClaims(proposedAd, 'advertisement'),
        ...modelClaims.filter((_, index) => result.flagged_claims[index].evidence_required),
      ])
      const unverifiedClaims = allAdClaims.filter(adClaim => {
        const knownClaim = evidenceClaims.find(claim => normalizeClaim(claim.text) === normalizeClaim(adClaim.text))
        return !knownClaim || claimEvidence[knownClaim.id]?.status !== 'verified'
      })
      const nextFindings = mergeFindings(result.findings, findingsFor(proposedAd))
      setFindings(nextFindings)

      if (unverifiedClaims.length) {
        setAdditionalClaims(current => [...current, ...unverifiedClaims.filter(next => !evidenceClaims.some(item => normalizeClaim(item.text) === normalizeClaim(next.text)) && !current.some(item => normalizeClaim(item.text) === normalizeClaim(next.text)))])
        setReturnToAdReview(true)
        setReviewStatus('needs-evidence')
        setRevisionHistory(current => [...current, { version: current.length + 1, copy: proposedAd, status: 'needs-evidence', findings: nextFindings, recordedAt: new Date().toLocaleString() }])
        setStep(1)
        return
      }

      const nextStatus = result.overall_assessment === 'no_obvious_issues' && !nextFindings.some(finding => finding.severity !== 'Info') ? 'approved' : 'needs-correction'
      setReviewStatus(nextStatus)
      setRevisionHistory(current => [...current, { version: current.length + 1, copy: proposedAd, status: nextStatus, findings: nextFindings, recordedAt: new Date().toLocaleString() }])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Vettora could not complete the AI review.'
      const fallbackFindings = findingsFor(proposedAd)
      setAiError(`${message} Showing the local checks only; this version is not AI-verified.`)
      setFindings(fallbackFindings)
      setReviewStatus('needs-correction')
    } finally {
      setAiLoading(false)
    }
  }
  const reset = () => {
    setStep(0); setBrand('GlowShield'); setProduct('GlowShield Sunscreen SPF 30'); setDescription('Broad-spectrum sunscreen with zinc oxide and aloe vera.\nClinically proven to help protect skin from UV rays.\nDermatologist recommended.\nApproved SPF: 30\nApproved discount: 10%'); setIngredients('Zinc oxide, aloe vera'); setRestrictions('Do not claim to cure acne or guarantee 100% sun protection.'); setClaimEvidence({}); setAdditionalClaims([]); setReturnToAdReview(false); setReviewStatus('not-checked'); setRevisionHistory([]); setAiFlaggedClaims([]); setAiReviewedCopy(''); setExtractedAdText(''); setAiError(''); packaging.clear(); adImages.clear(); revisionImages.clear(); setAdHeadline(initialHeadline); setAdClaims(initialAdClaims); setAdDescription(initialAdDescription); setSuggestedCopy(''); setFindings([]); setChecked(false)
  }
  const imagePicker = (label: string, add: (files: FileList | null) => void) => <label className="upload-control">{label}<input type="file" accept="image/*" multiple onChange={event => { add(event.target.files); event.currentTarget.value = '' }} /></label>
  const previews = (items: Upload[], remove: () => void) => items.length > 0 && <div className="image-previews">{items.map((item, index) => <figure key={`${item.url}-${index}`}><img src={item.url} alt={item.name} /><figcaption>{item.name}</figcaption></figure>)}<button type="button" className="text-button" onClick={remove}>Remove images</button></div>
  if (!authenticated) return <main className="auth-page"><div className="auth-atmosphere" /><section className="auth-content"><div className="auth-brand"><img src={`${import.meta.env.BASE_URL}vettora-logo.png`} alt="Vettora" /></div><div className="auth-heading"><p>WELCOME TO VETTORA</p><h1>{authMode === 'login' ? 'Your brand, in good hands.' : 'Join your workspace.'}</h1><span>{authMode === 'login' ? 'Sign in to continue to your workspace.' : 'Create an account with your company email.'}</span></div>
    {authMode === 'login' ? <form className="auth-form" onSubmit={event => { event.preventDefault(); setAuthMessage(''); setAuthenticated(true) }}><div className="form-control"><input id="login-id" autoComplete="username" placeholder=" " value={loginId} onChange={event => setLoginId(event.target.value)} /><label htmlFor="login-id">Username or ID</label></div><div className="form-control"><input id="login-password" type="password" autoComplete="current-password" placeholder=" " value={loginPassword} onChange={event => setLoginPassword(event.target.value)} /><label htmlFor="login-password">Password</label></div><button className="auth-submit" type="submit">Sign in <span>→</span></button></form> : <form className="auth-form" autoComplete="off" onSubmit={event => { event.preventDefault(); setAuthMessage(''); setAuthenticated(true) }}><div className="form-control"><input id="signup-email" type="email" autoComplete="off" placeholder=" " required value={signupEmail} onChange={event => setSignupEmail(event.target.value)} /><label htmlFor="signup-email">Company email</label></div><div className="form-control"><input id="signup-password" type="password" autoComplete="new-password" placeholder=" " minLength={8} required value={signupPassword} onChange={event => setSignupPassword(event.target.value)} /><label htmlFor="signup-password">Create password</label></div><div className="form-control"><select id="companies" value={companies} onChange={event => setCompanies(event.target.value)}><option value=""></option></select><label htmlFor="companies">Companies you work on <small>(optional)</small></label></div><button className="auth-submit" type="submit">Create account <span>→</span></button></form>}
    {authMessage && <p className="auth-message" role="alert">{authMessage}</p>}<p className="auth-switch">{authMode === 'login' ? 'New to Vettora?' : 'Already have an account?'} <button type="button" onClick={() => { setAuthMode(authMode === 'login' ? 'signup' : 'login'); setAuthMessage('') }}>{authMode === 'login' ? 'Create an account' : 'Sign in'}</button></p><p className="auth-prototype">Prototype sign-in · Account details are not verified or saved.</p></section><div className="auth-footer"><span>VETTORA © 2026</span><span>Clear claims. Consistent brands.</span></div></main>
  if (activeTab === 'guidelines') return <div className="app-shell">
    <aside className="sidebar"><a className="brand-lockup" href="#" aria-label="Vettora home"><img className="brand-logo" src={vettoraLogo} alt="Vettora — Brand Intelligence" /></a><div className="nav-label">WORKSPACE</div><button className="nav-item" onClick={() => setActiveTab('home')}><span>⌂</span> Home</button><button className="nav-item" onClick={() => setActiveTab('review')}><span>◈</span> Content review</button><button className="nav-item" onClick={() => setActiveTab('history')}><span>◷</span> Past reviews</button><button className="nav-item active" onClick={() => setActiveTab('guidelines')}><span>▤</span> Content guidelines</button><button className="nav-item" onClick={() => { reset(); setStep(0); setActiveTab('review') }}><span>↺</span> Reset demo</button>{<div className="sidebar-bottom account-sidebar"><span className="account-avatar">{accountInitials || 'A'}</span><div><strong>{accountName}</strong>{accountEmail && <small>{accountEmail}</small>}</div></div>}</aside>
    <main className="main-content"><header className="topbar"><span>Workspace <span className="crumb">/ Content guidelines</span></span><span className="demo-pill">● Coming soon</span></header><section className="guidelines-page"><div className="guidelines-card"><div className="guidelines-icon">✦</div><div className="eyebrow">VETTORA / CONTENT GUIDELINES</div><h1>We will get back to you soon.</h1><p>This page is under construction.</p></div><footer><span>VETTORA © 2026</span><span>Clear claims. Consistent brands.</span></footer></section></main>
  </div>
  if (activeTab === 'home') return <div className="app-shell">
    <aside className="sidebar"><a className="brand-lockup" href="#" aria-label="Vettora home"><img className="brand-logo" src={vettoraLogo} alt="Vettora — Brand Intelligence" /></a><div className="nav-label">WORKSPACE</div><button className="nav-item active" onClick={() => setActiveTab('home')}><span>⌂</span> Home</button><button className="nav-item" onClick={() => setActiveTab('review')}><span>◈</span> Content review</button><button className="nav-item" onClick={() => setActiveTab('history')}><span>◷</span> Past reviews</button><button className="nav-item" onClick={() => setActiveTab('guidelines')}><span>▤</span> Content guidelines</button><button className="nav-item" onClick={() => { reset(); setStep(0); setActiveTab('review') }}><span>↺</span> Reset demo</button>{<div className="sidebar-bottom account-sidebar"><span className="account-avatar">{accountInitials || 'A'}</span><div><strong>{accountName}</strong>{accountEmail && <small>{accountEmail}</small>}</div></div>}</aside>
    <main className="main-content"><header className="topbar"><span>Workspace <span className="crumb">/ Home</span></span><span className="demo-pill">● Prototype</span></header><section className="home-page"><div className="home-hero"><div className="eyebrow">VETTORA / BRAND INTELLIGENCE</div><h1>Welcome to <em>Vettora.</em></h1><p>Keep your product information, supporting evidence, and advertising claims in one clear review workspace.</p><button className="review-button" onClick={() => setActiveTab('guidelines')}>Content guidelines <span>→</span></button></div><div className="home-overview"><article className="home-stat-card"><span className="home-stat-label">PAST REVIEWS</span><strong>{pastReviews.length}</strong><span>Products reviewed in this browser</span><button className="text-button" onClick={() => setActiveTab('history')}>View past reviews →</button></article><article className="home-action-card"><div className="home-action-icon">◈</div><h2>Review a product</h2><p>Add a product reference, check claims and evidence, then submit the advertisement for review.</p><button className="secondary-button" onClick={() => { setStep(0); setActiveTab('review') }}>Open content review →</button></article></div><footer><span>VETTORA © 2026</span><span>Clear claims. Consistent brands.</span></footer></section></main>
  </div>
  if (activeTab === 'history') return <div className="app-shell">
    <aside className="sidebar"><a className="brand-lockup" href="#" aria-label="Vettora home"><img className="brand-logo" src={vettoraLogo} alt="Vettora — Brand Intelligence" /></a><div className="nav-label">WORKSPACE</div><button className="nav-item" onClick={() => setActiveTab('home')}><span>⌂</span> Home</button><button className="nav-item" onClick={() => setActiveTab('review')}><span>◈</span> Content review</button><button className="nav-item active" onClick={() => setActiveTab('history')}><span>◷</span> Past reviews</button><button className="nav-item" onClick={() => setActiveTab('guidelines')}><span>▤</span> Content guidelines</button><button className="nav-item" onClick={() => { reset(); setActiveTab('review') }}><span>↺</span> Reset demo</button>{<div className="sidebar-bottom account-sidebar"><span className="account-avatar">{accountInitials || 'A'}</span><div><strong>{accountName}</strong>{accountEmail && <small>{accountEmail}</small>}</div></div>}</aside>
    <main className="main-content"><header className="topbar"><span>Workspace <span className="crumb">/ Past reviews</span></span><span className="demo-pill">● Prototype</span></header><section className="history-page"><div className="page-heading"><div className="eyebrow">WORKSPACE / ARCHIVE</div><h1>Past <em>reviews.</em></h1><p>Products and advertisements previously submitted for review.</p></div>{pastReviews.length ? <div className="history-list">{pastReviews.map(review => <article className="history-card" key={review.id}><div className="history-card-main"><span className="history-brand">{review.brand}</span><h2>{review.product}</h2><span className="history-date">{new Date(review.reviewedAt).toLocaleString()}</span></div><div className="history-card-meta"><span className="history-status">{review.status}</span><span>{review.findingCount} finding{review.findingCount === 1 ? '' : 's'}</span></div></article>)}</div> : <div className="empty-state"><div className="empty-symbol">◷</div><strong>No past reviews yet</strong><p>Completed product reviews will appear here.</p><button className="review-button" onClick={() => setActiveTab('review')}>Start a review</button></div>}<footer><span>VETTORA © 2026</span><span>Clear claims. Consistent brands.</span></footer></section></main>
  </div>
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand-lockup" href="#" aria-label="Vettora home"><img className="brand-logo" src={vettoraLogo} alt="Vettora — Brand Intelligence" /></a><div className="nav-label">WORKSPACE</div><button className="nav-item" onClick={() => setActiveTab('home')}><span>⌂</span> Home</button><button className="nav-item active" onClick={() => setActiveTab('review')}><span>◈</span> Content review</button><button className="nav-item" onClick={() => setActiveTab('history')}><span>◷</span> Past reviews</button><button className="nav-item" onClick={() => setActiveTab('guidelines')}><span>▤</span> Content guidelines</button><button className="nav-item" onClick={reset}><span>↺</span> Reset demo</button>{<div className="sidebar-bottom account-sidebar"><span className="account-avatar">{accountInitials || 'A'}</span><div><strong>{accountName}</strong>{accountEmail && <small>{accountEmail}</small>}</div></div>}</aside>
    <main className="main-content"><header className="topbar"><span>Workspace <span className="crumb">/ Content review</span></span><span className="demo-pill">● Prototype</span></header>
      {step === 0 && <section className="page-heading"><div className="eyebrow">BRAND GOVERNANCE / CONTENT INTELLIGENCE</div><h1>Make every claim <em>count.</em></h1><p>Build a product reference, add supporting evidence, then review the advertisement step by step.</p></section>}
      <nav className="workflow" aria-label="Review steps">{steps.map((title, index) => <div key={title} className={`workflow-step ${step === index ? 'current' : ''} ${step > index ? 'complete' : ''}`}><span>0{index + 1}</span>{title}</div>)}</nav>
      {step === 0 && <section className="panel step-panel"><div className="panel-heading"><div><div className="panel-kicker">01 / PRODUCT PROFILE</div><h2>What product are we reviewing?</h2></div><span className="step-icon">✳</span></div><p className="panel-description">Create the reference details the advertisement will be checked against.</p><div className="form-grid"><div><label htmlFor="brand">Brand name</label><input id="brand" value={brand} onChange={event => setBrand(event.target.value)} placeholder="e.g. GlowShield" /></div><div><label htmlFor="product">Product name</label><input id="product" value={product} onChange={event => setProduct(event.target.value)} placeholder="Product name and variant" /></div></div><label htmlFor="description">Product description &amp; specifications</label><textarea id="description" value={description} onChange={event => setDescription(event.target.value)} placeholder="Describe the product and approved values, such as SPF or offer limits." /><div className="ad-copy-fields"><div className="panel-kicker ad-copy-kicker">ADVERTISEMENT CONTENT</div><p className="ad-copy-intro">Add the headline, claims, and body text from the ad. Vettora checks these fields together against the product information.</p><label htmlFor="ad-headline">Advertisement headline</label><input id="ad-headline" value={adHeadline} onChange={event => { setAdHeadline(event.target.value); setReviewStatus('not-checked'); setChecked(false) }} placeholder="Enter the ad headline" /><label htmlFor="ad-claims">Claims in the advertisement</label><textarea id="ad-claims" className="short-textarea" value={adClaims} onChange={event => { setAdClaims(event.target.value); setReviewStatus('not-checked'); setChecked(false) }} placeholder="Enter the product claims made in the ad" /><label htmlFor="ad-description">Advertisement description and offer</label><textarea id="ad-description" className="short-textarea" value={adDescription} onChange={event => { setAdDescription(event.target.value); setReviewStatus('not-checked'); setChecked(false) }} placeholder="Enter the ad body, caption, offer, or call to action" /><p className="field-hint">These three text fields are checked together against the product description and evidence. The AI also checks text visible in the ad image.</p></div><label htmlFor="ingredients">Ingredients</label><textarea id="ingredients" className="short-textarea" value={ingredients} onChange={event => setIngredients(event.target.value)} placeholder="List ingredients, separated by commas" /><label>Packaging photos</label>{imagePicker('Choose packaging images', packaging.add)}{previews(packaging.files, packaging.clear)}<p className="field-hint"><span className="tiny-dot" /> Packaging images are previewed only; label text is not read automatically.</p><label>Advertisement image</label>{imagePicker('Choose advertisement image', adImages.add)}<div className="image-previews">{adImages.files.map((item, index) => <figure key={`${item.url}-${index}`}><img src={item.url} alt={item.name} /><figcaption>{item.name}</figcaption></figure>)}</div><p className="field-hint">Vettora AI reads the ad image during Reverify to extract visible text and claims.</p><div className="step-actions"><span>{profileComplete ? 'Product profile started' : 'Add a brand, product name, and description to continue'}</span><button className="review-button" disabled={!profileComplete} onClick={() => setStep(1)}>Continue to evidence →</button></div></section>}
      {step === 1 && <section className="panel step-panel"><div className="panel-heading"><div><div className="panel-kicker">02 / EVIDENCE &amp; CLAIMS</div><h2>Review evidence for flagged claims</h2></div><span className="step-icon">✓</span></div><p className="panel-description">Claims detected in the product description and new ad copy appear here. Review the supporting files and mark each claim verified only after a human has checked the evidence.</p>{evidenceClaims.length ? <div className="claim-evidence-list">{evidenceClaims.map((claim, index) => { const record = claimEvidence[claim.id] ?? { files: [], status: 'pending' as const }; return <article className="claim-evidence-card" key={claim.id}><div className="claim-evidence-heading"><span className="claim-number">CLAIM 0{index + 1}</span><span className={`status-badge evidence-${record.status}`}>{record.status === 'verified' ? 'Verified by reviewer' : record.status === 'needs-proof' ? 'More evidence needed' : 'Proof requested'}</span></div><h3>{claim.text}</h3><p><strong>Flagged because:</strong> {claim.reasons.join(', ')}. Provide evidence supporting this statement, such as a relevant certificate, accredited lab test, or substantiation report.</p><span className="detected-keywords">Matched wording: {claim.keywords.join(' · ')}</span><label htmlFor={`evidence-${index}`}>Certificate or lab test</label><input id={`evidence-${index}`} className="file-input" type="file" multiple accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={event => { const names = Array.from(event.target.files ?? []).map(file => file.name); setClaimEvidence(current => ({ ...current, [claim.id]: { files: [...(current[claim.id]?.files ?? []), ...names], status: 'pending' } })); event.currentTarget.value = '' }} /><p className="field-hint">Files are listed locally; they are not uploaded or automatically checked.</p>{record.files.length > 0 && <ul className="evidence-list">{record.files.map((name, fileIndex) => <li key={`${name}-${fileIndex}`}>◈ {name}<span>{record.status === 'verified' ? 'Reviewed' : 'Awaiting human review'}</span></li>)}</ul>}<div className="evidence-actions"><button className="secondary-button" disabled={!record.files.length} onClick={() => setClaimEvidence(current => ({ ...current, [claim.id]: { ...record, status: 'verified' } }))}>Mark evidence verified</button><button className="text-button" onClick={() => setClaimEvidence(current => ({ ...current, [claim.id]: { ...record, status: 'needs-proof' } }))}>Needs more evidence</button></div></article>})}</div> : <div className="request-card"><strong>No flagged claims to verify</strong><p>The description scan did not find its evidence trigger phrases. This does not prove every claim is substantiated.</p></div>}<label htmlFor="restrictions">Restricted wording &amp; other rules</label><textarea id="restrictions" className="short-textarea" value={restrictions} onChange={event => setRestrictions(event.target.value)} placeholder="Claims the advertisement must not make" /><div className="step-actions"><button className="secondary-button" onClick={() => setStep(0)}>← Back to product profile</button><button className="review-button" onClick={() => { setReturnToAdReview(false); setStep(2) }}>{returnToAdReview ? 'Return to advertisement →' : 'Continue to advertisement →'}</button></div></section>}      {step === 2 && <section className="panel step-panel"><div className="panel-heading"><div><div className="panel-kicker">03 / ADVERTISEMENT REVIEW</div><h2>Flagged claims and corrections</h2></div><span className="step-icon">↗</span></div><p className="panel-description">Review the claims detected in the submitted ad and the suggested corrections. Then enter the corrected copy or upload a revised image below.</p>{adImages.files.length > 0 && <div className="image-previews ad-reference-preview">{adImages.files.map((item, index) => <figure key={`${item.url}-${index}`}><img src={item.url} alt={item.name} /><figcaption>Submitted: {item.name}</figcaption></figure>)}</div>}<section className="ad-flags-panel"><h3>Claims flagged in the advertisement</h3>{aiError && <div className="ai-error" role="alert">{aiError}</div>}{aiReviewedCopy === proposedAd && extractedAdText && <div className="extracted-ad-text"><strong>Text read from the ad image</strong><p>{extractedAdText}</p></div>}{previewClaims.length ? <div className="claim-evidence-list">{previewClaims.map(claim => { const normalized = claim.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); const knownClaim = evidenceClaims.find(item => item.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === normalized); const isVerified = Boolean(knownClaim && claimEvidence[knownClaim.id]?.status === 'verified'); return <article className="claim-evidence-card" key={claim.id}><div className="claim-evidence-heading"><span className="claim-number">{claim.reasons.join(' · ')}</span><span className={`status-badge ${isVerified ? 'evidence-verified' : 'evidence-pending'}`}>{isVerified ? 'Evidence verified' : 'Needs evidence or correction'}</span></div><h3>{claim.text}</h3><p>{isVerified ? 'This statement has evidence marked verified in Step 2. Keep the final wording consistent with the approved claim.' : 'Provide supporting evidence in Step 2, or remove/rewrite this statement to avoid an unsupported promise.'}</p><span className="detected-keywords">Matched wording: {claim.keywords.join(' · ')}</span></article>})}</div> : <p className="approved-note">No high-risk claim wording detected in the ad copy. Review the remaining findings below before submitting.</p>}{previewFindings.some(finding => finding.severity !== 'Info') && <div className="finding-list">{previewFindings.filter(finding => finding.severity !== 'Info').map((finding, index) => <article className="finding-card" key={`${finding.title}-${index}`}><span className={`severity ${finding.severity.toLowerCase()}`}>{finding.severity}</span><h3>{finding.title}</h3><p>{finding.detail}</p><div className="suggestion"><strong>Suggested correction</strong><p>{finding.suggestion}</p></div></article>)}</div>}</section><label htmlFor="suggested-copy">Your corrections or replacement copy</label><textarea id="suggested-copy" className="ad-input" value={suggestedCopy} onChange={event => { setSuggestedCopy(event.target.value); setReviewStatus('not-checked') }} placeholder="Enter the corrected advertising copy you want to use. Reverify will check this version." /><label className="revision-image-label">Corrected advertisement image</label>{imagePicker('Choose corrected ad image', files => { revisionImages.add(files); setReviewStatus('not-checked') })}{previews(revisionImages.files, revisionImages.clear)}<p className="field-hint">Text in images is not extracted automatically; enter all visible wording in the copy above.</p>{reviewStatus !== 'not-checked' && <div className={`verification-panel verification-${reviewStatus}`}><div className="verification-heading"><strong>{reviewStatus === 'approved' ? 'The corrected ad has passed the current checks.' : reviewStatus === 'needs-evidence' ? 'New or unverified claims need evidence.' : 'Corrections are still needed.'}</strong><span className={`status-badge evidence-${reviewStatus}`}>{reviewStatus === 'approved' ? 'Approved' : reviewStatus === 'needs-evidence' ? 'Sent to Evidence & Claims' : 'Not approved'}</span></div></div>}<div className="step-actions review-actions"><button className={`verification-status-button verification-${reviewStatus}`} disabled>{reviewStatus === 'approved' ? 'Verified ✓' : reviewStatus === 'needs-evidence' ? 'Evidence needed' : reviewStatus === 'needs-correction' ? 'Corrections needed' : 'Not verified yet'}</button><button className="secondary-button" disabled={aiLoading} onClick={reverify}>{aiLoading ? 'Reviewing with AI…' : 'Reverify claims'}</button><button className="review-button" onClick={runReview}>Submit for review →</button></div></section>}      {step === 3 && <section className="results-section">{!checked ? <div className="empty-state"><div className="empty-symbol">✳</div><strong>Your review starts here</strong><p>Complete the advertisement step to see findings.</p><button className="review-button" onClick={() => setStep(2)}>Back to advertisement</button></div> : <><div className="report-actions screen-report-actions"><span className="result-count">{findings.length} finding{findings.length !== 1 ? 's' : ''}</span><button className="secondary-button export-button" onClick={exportReview}>Export review</button></div><article className="report-page report-summary-page"><header className="report-brand"><img src={vettoraLogo} alt="Vettora" /><span>BRAND CONTENT REVIEW</span></header><h1>Advertisement Review Report</h1><p className="report-subtitle">Review summary, corrections, and verification history</p><div className="report-meta"><div><small>BRAND</small><strong>{brand}</strong></div><div><small>PRODUCT</small><strong>{product}</strong></div><div><small>REVIEW DATE</small><strong>{new Date().toLocaleDateString()}</strong></div><div><small>STATUS</small><strong>{reviewStatus === 'approved' ? 'Verified' : reviewStatus === 'needs-evidence' ? 'Evidence requested' : reviewStatus === 'needs-correction' ? 'Corrections needed' : 'Submitted for review'}</strong></div></div><div className="report-section"><h2>Review outcome</h2><div className="summary-row"><div className="summary-card"><span className="summary-number">{findings.length}</span><span>Total findings</span></div><div className="summary-card high-summary"><span className="summary-number">{highCount}</span><span>High priority</span></div><div className="summary-card medium-summary"><span className="summary-number">{mediumCount}</span><span>Needs verification</span></div></div></div><div className="report-section"><h2>Changes made</h2>{proposedAd.trim() !== ad.trim() ? <div className="before-after"><div><span>SUBMITTED COPY</span><p>{ad || 'No original copy provided.'}</p></div><div><span>REVISED COPY</span><p>{proposedAd || 'No revised copy provided.'}</p></div></div> : <p className="report-note">No copy changes were recorded before submission.</p>}</div><div className="report-section"><h2>Previous review attempts</h2>{revisionHistory.length ? <ol className="revision-timeline">{revisionHistory.map(revision => <li key={revision.version}><div className="revision-timeline-heading"><strong>Version {revision.version}</strong><span>{revision.status === 'approved' ? 'Verified' : revision.status === 'needs-evidence' ? 'Sent for evidence' : revision.status === 'needs-correction' ? 'Changes requested' : 'Not verified'}</span><time>{revision.recordedAt}</time></div><p>{revision.copy}</p>{revision.findings.length > 0 && <small>Findings: {revision.findings.map(finding => finding.title).join(' · ')}</small>}</li>)}</ol> : <p className="report-note">No earlier re-verification attempts were recorded.</p>}</div><p className="report-disclaimer">Prototype report · Checks are preliminary. Uploaded evidence is reviewed by a person; this report is not a legal compliance certificate.</p></article><article className="report-page report-creative-page"><header className="report-brand"><img src={vettoraLogo} alt="Vettora" /><span>FLAGGED CREATIVE &amp; COPY</span></header><h1>Advertisement evidence</h1><p className="report-subtitle">The image and copy assessed in this review</p><div className="report-section"><h2>Submitted advertisement image</h2>{adImages.files.length ? <div className="report-image-grid">{adImages.files.map((image, index) => <figure key={`${image.url}-${index}`}><img src={image.url} alt={image.name} /><figcaption>{image.name}</figcaption></figure>)}</div> : <p className="report-note">No original ad image was provided.</p>}</div><div className="report-section"><h2>Caption and ad copy reviewed</h2><blockquote className="report-copy">{ad || 'No advertisement copy provided.'}</blockquote></div>{extractedAdText && <div className="report-section"><h2>Text extracted from submitted image</h2><blockquote className="report-copy">{extractedAdText}</blockquote></div>}{revisionImages.files.length > 0 && <div className="report-section"><h2>Corrected advertisement image</h2><div className="report-image-grid">{revisionImages.files.map((image, index) => <figure key={`${image.url}-${index}`}><img src={image.url} alt={image.name} /><figcaption>{image.name}</figcaption></figure>)}</div></div>}{proposedAd.trim() !== ad.trim() && <div className="report-section"><h2>Corrected caption and ad copy</h2><blockquote className="report-copy">{proposedAd}</blockquote></div>}<div className="report-section"><h2>Flagged claims and suggested corrections</h2>{findings.length ? <div className="finding-list">{findings.map((finding, index) => <article className="finding-card" key={`${finding.title}-${index}`}><div className="finding-top"><span className={`severity ${finding.severity.toLowerCase()}`}>{finding.severity}</span><span className="finding-number">FINDING 0{index + 1}</span></div><h3>{finding.title}</h3><p>{finding.detail}</p><div className="suggestion"><strong>Suggested correction</strong><p>{finding.suggestion}</p></div></article>)}</div> : <p className="report-note">No findings were recorded for this ad.</p>}</div><p className="report-disclaimer">AI image reading may miss text or context. Confirm the extracted copy and have a human reviewer assess the findings.</p></article><div className="step-actions screen-report-actions"><button className="secondary-button" onClick={() => setStep(2)}>← Edit advertisement</button><button className="review-button" onClick={reset}>Start a new review</button></div></>}</section>}      <footer><span>VETTORA © 2026</span><span>Clear claims. Consistent brands.</span></footer>
    </main>
  </div>
}

export default App
