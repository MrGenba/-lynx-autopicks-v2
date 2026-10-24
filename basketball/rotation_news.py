"""Extract explicit public rotation evidence; no inferred medical clearance."""
import re
from datetime import date, timedelta

POLICY = 'bk-rotation-news-1'
WEEKDAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']


def signals(name, headline, summary, day):
    text = (headline+' . '+summary).replace('\u2019', "'")
    lower = text.lower()
    staff = bool(re.search(r'\b(?:head coach|coach|coaching staff|medical staff|team announced|team confirmed)\b', lower))
    risk = bool(re.search(r'\b(?:injur\w*|restriction|restricted|limit\w*|ramp\w*|resting|suspend\w*|scratch\w*|workload)\b', lower)
                or re.search(r'\b(?:will|expected to|set to) (?:return|start|come off the bench)\b', lower))
    out = {'policy':POLICY, 'staff_attributed':staff, 'rotation_risk':risk}
    # Date-only reports cannot establish intraday ordering. They may constrain
    # workload but never lift a restriction or establish medical clearance.
    target = None
    if re.search(r'\b(?:tonight|today)\b', lower):target=day
    elif re.search(r'\btomorrow\b', lower):target=(date.fromisoformat(day)+timedelta(days=1)).isoformat()
    else:
        days = [i for i,d in enumerate(WEEKDAYS) if re.search(r'\b'+d+r"(?:'s)?\b", lower)]
        if len(days)==1:
            start=date.fromisoformat(day);delta=(days[0]-start.weekday())%7
            if delta<=2:target=(start+timedelta(days=delta)).isoformat()
    out['target_date']=target
    returning = bool(re.search(r'\b(?:will return|set to return|expected to return|return from|returning from|back from|ramp.up|eased back)\b', lower))
    if re.search(r"\b(?:won't|will not|not expected to|not ready to) return\b", lower):returning=False
    out['returning']=returning
    out['unrestricted_reported']=bool(staff and re.search(r"\b(?:no minutes (?:limit|restriction)|(?:won't|will not) (?:have|face|be under) (?:a |any )?minutes (?:limit|restriction))\b", lower))
    # Only a sentence that explicitly names this player may supply a numeric cap.
    surname=re.sub(r'\s+(?:Jr\.?|Sr\.?|II|III|IV)$','',name,flags=re.I).split()[-1]
    subject=r'\b(?:'+re.escape(name)+'|'+re.escape(surname)+r")\s*(?:\([^)]*\)\s*)?(?:will|is|was expected to|is expected to|has been|remains)\b"
    caps=[]
    for sentence in re.split(r'(?<=[.!?])\s+', summary):
        match=re.search(subject,sentence,re.I)
        if not match:continue
        clause=re.split(r'\b(?:while|whereas|but|with)\b',sentence[match.start():],maxsplit=1,flags=re.I)[0]
        if re.search(r"\b(?:no|without|not|won't)\b",clause,re.I):continue
        if not re.search(r'\b(?:limited|limit|restriction|restricted|cap|capped|maximum|no more than)\b',clause,re.I):continue
        m=re.search(r'\b(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s*(?:-|\s)?minutes?\b',clause,re.I)
        if m:
            lo=int(m[1]);hi=int(m[2] or m[1])
            if 0<lo<=hi<=48:caps.append((lo,hi))
    if staff and target and len(set(caps))==1:
        out.update(minutes_cap=caps[0][1],announced_range=list(caps[0]),numeric_evidence='EXPLICIT_STAFF_CAP')
    return out
