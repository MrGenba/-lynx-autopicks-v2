import pytest
from basketball.context_sources import injury_rows

def test_leading_reason_fragment_continues_previous_page_explicit_row():
    cols=[100,200,300,400,500]
    lines=[(89,[(510,'Fracture')]),(111,[(510,'Injury/Illness - Left Knee')]),(118,[(310,'Leonard, Kawhi'),(410,'Out')]),(125,[(510,'Soreness')])]
    leading=[];rows=list(injury_rows(lines,cols,75,500,leading))
    assert leading==['Fracture']
    assert rows[0][5]=='Injury/Illness - Left Knee Soreness'

def test_first_page_or_ambiguous_middle_fragment_stays_invalid():
    cols=[100,200,300,400,500]
    with pytest.raises(ValueError):list(injury_rows([(89,[(510,'Fracture')]),(118,[(310,'Player, Test'),(410,'Out')])],cols,75,500))
    with pytest.raises(ValueError):list(injury_rows([(100,[(310,'One, Test'),(410,'Out')]),(120,[(510,'ambiguous')]),(140,[(310,'Two, Test'),(410,'Out')])],cols,75,500,[]))
